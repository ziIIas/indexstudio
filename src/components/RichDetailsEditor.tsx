import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import type { DetailImageLines, DetailNode, DetailsDocument } from "../types";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const LINE_PRESETS: DetailImageLines[] = [5, 7, 10];
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export interface RichDetailsEditorHandle { focusAt: (offset?: number) => void; }

export function detailsDocumentFromText(text: string): DetailsDocument {
  return { version: 1, nodes: text ? [{ type: "text", text }] : [] };
}

export function plainDetails(document: DetailsDocument | null | undefined, fallback = "") {
  if (!document) return fallback;
  return document.nodes.filter((node): node is Extract<DetailNode, { type: "text" }> => node.type === "text").map((node) => node.text).join("").replaceAll("\u200b", "");
}

function appendText(nodes: DetailNode[], text: string) {
  const clean = text.replaceAll("\u200b", "");
  if (!clean) return;
  const last = nodes.at(-1);
  if (last?.type === "text") last.text += clean;
  else nodes.push({ type: "text", text: clean });
}

function readDocument(editor: HTMLElement): DetailsDocument {
  const nodes: DetailNode[] = [];
  const walk = (parent: Node) => {
    parent.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) { appendText(nodes, child.textContent ?? ""); return; }
      if (!(child instanceof HTMLElement)) return;
      if (child instanceof HTMLImageElement && child.dataset.detailImage === "true") {
        nodes.push({
          type: "image",
          dataUrl: child.src,
          naturalWidth: Number(child.dataset.naturalWidth),
          naturalHeight: Number(child.dataset.naturalHeight),
          lines: Number(child.dataset.lines) as DetailImageLines,
        });
        return;
      }
      if (child.tagName === "BR") { appendText(nodes, "\n"); return; }
      const block = /^(DIV|P|LI)$/.test(child.tagName);
      if (block && nodes.length && nodes.at(-1)?.type === "text" && !(nodes.at(-1) as Extract<DetailNode, { type: "text" }>).text.endsWith("\n")) appendText(nodes, "\n");
      walk(child);
      if (block) appendText(nodes, "\n");
    });
  };
  walk(editor);
  return { version: 1, nodes };
}

function imageElement(node: Extract<DetailNode, { type: "image" }>, lineHeight: number) {
  const image = new Image();
  image.src = node.dataUrl;
  image.alt = "Pasted detail image";
  image.contentEditable = "false";
  image.draggable = false;
  image.dataset.detailImage = "true";
  image.dataset.naturalWidth = String(node.naturalWidth);
  image.dataset.naturalHeight = String(node.naturalHeight);
  image.dataset.lines = String(node.lines);
  image.style.height = `${node.lines * lineHeight}px`;
  image.style.width = "auto";
  return image;
}

function fileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read the pasted image."));
    reader.readAsDataURL(file);
  });
}

function imageDimensions(dataUrl: string) {
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error("The pasted image could not be opened."));
    image.src = dataUrl;
  });
}

export const RichDetailsEditor = forwardRef<RichDetailsEditorHandle, {
  initialDocument: DetailsDocument | null | undefined;
  initialText: string;
  onChange: (document: DetailsDocument, plainText: string) => void;
  onError: (message: string) => void;
  placeholder?: string;
}>(({ initialDocument, initialText, onChange, onError, placeholder }, forwardedRef) => {
  const editorRef = useRef<HTMLDivElement>(null);
  const [selectedImage, setSelectedImage] = useState<HTMLImageElement | null>(null);
  const [customLines, setCustomLines] = useState("5");

  const lineHeight = () => {
    const editor = editorRef.current;
    if (!editor) return 18;
    const style = window.getComputedStyle(editor);
    const parsed = Number.parseFloat(style.lineHeight);
    return Number.isFinite(parsed) ? parsed : Number.parseFloat(style.fontSize) * 1.45;
  };
  const availableWidth = () => {
    const editor = editorRef.current;
    if (!editor) return 0;
    const style = window.getComputedStyle(editor);
    return editor.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
  };
  const availableHeight = () => {
    const editor = editorRef.current;
    if (!editor) return 0;
    const style = window.getComputedStyle(editor);
    return editor.clientHeight - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom);
  };
  const fitError = (width: number, height: number, lines: DetailImageLines) => {
    const targetHeight = lines * lineHeight();
    if ((width / height) * targetHeight > availableWidth()) return `This image is too wide at ${lines} lines high and would be cut off.`;
    if (targetHeight > availableHeight()) return `This image is too tall at ${lines} lines high and would be cut off.`;
    return "";
  };
  const emitChange = () => {
    const editor = editorRef.current;
    if (!editor) return;
    const document = readDocument(editor);
    onChange(document, plainDetails(document));
  };

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.replaceChildren();
    const detailsDoc = initialDocument ?? detailsDocumentFromText(initialText);
    for (const node of detailsDoc.nodes) {
      if (node.type === "text") editor.append(window.document.createTextNode(node.text));
      else editor.append(imageElement(node, lineHeight()));
    }
  }, []);

  useImperativeHandle(forwardedRef, () => ({
    focusAt(offset) {
      const editor = editorRef.current;
      if (!editor) return;
      editor.focus({ preventScroll: true });
      const range = document.createRange();
      const selection = window.getSelection();
      let remaining = Math.max(0, offset ?? Number.MAX_SAFE_INTEGER);
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        const length = node.textContent?.length ?? 0;
        if (remaining <= length) { range.setStart(node, remaining); range.collapse(true); selection?.removeAllRanges(); selection?.addRange(range); return; }
        remaining -= length;
        node = walker.nextNode();
      }
      range.selectNodeContents(editor); range.collapse(false); selection?.removeAllRanges(); selection?.addRange(range);
    },
  }), []);

  const selectImage = (image: HTMLImageElement) => {
    setSelectedImage(image);
    setCustomLines(image.dataset.lines ?? "5");
    const range = document.createRange();
    range.selectNode(image);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  };
  const resizeSelected = (lines: DetailImageLines) => {
    if (!selectedImage?.isConnected) return;
    if (!Number.isInteger(lines) || lines < 1 || lines > 50) { onError("Choose an image height from 1 to 50 lines."); return; }
    const width = Number(selectedImage.dataset.naturalWidth);
    const height = Number(selectedImage.dataset.naturalHeight);
    const error = fitError(width, height, lines);
    if (error) { onError(error); return; }
    selectedImage.dataset.lines = String(lines);
    selectedImage.style.height = `${lines * lineHeight()}px`;
    setCustomLines(String(lines));
    emitChange();
  };
  const applyCustomLines = () => {
    const lines = Number(customLines);
    if (!Number.isInteger(lines) || lines < 1 || lines > 50) { onError("Choose an image height from 1 to 50 lines."); return; }
    resizeSelected(lines);
  };
  const insertText = (text: string) => {
    const editor = editorRef.current;
    if (!editor) return;
    const selection = window.getSelection();
    const range = selection?.rangeCount && editor.contains(selection.anchorNode) ? selection.getRangeAt(0) : document.createRange();
    if (!selection?.rangeCount || !editor.contains(selection.anchorNode)) { range.selectNodeContents(editor); range.collapse(false); }
    range.deleteContents();
    const textNode = document.createTextNode(text.replace(/\r\n?/g, "\n"));
    range.insertNode(textNode);
    range.setStartAfter(textNode); range.collapse(true);
    selection?.removeAllRanges(); selection?.addRange(range);
    emitChange();
  };
  const insertLineBreak = () => {
    const editor = editorRef.current;
    if (!editor) return;
    const selection = window.getSelection();
    const range = selection?.rangeCount && editor.contains(selection.anchorNode) ? selection.getRangeAt(0) : document.createRange();
    if (!selection?.rangeCount || !editor.contains(selection.anchorNode)) { range.selectNodeContents(editor); range.collapse(false); }
    range.deleteContents();
    const lineBreak = document.createElement("br");
    const caretAnchor = document.createTextNode("\u200b");
    const fragment = document.createDocumentFragment();
    fragment.append(lineBreak, caretAnchor);
    range.insertNode(fragment);
    range.setStart(caretAnchor, 0); range.collapse(true);
    selection?.removeAllRanges(); selection?.addRange(range);
    emitChange();
  };
  const pasteImages = async (files: File[]) => {
    const editor = editorRef.current;
    if (!editor) return;
    const selection = window.getSelection();
    const range = selection?.rangeCount && editor.contains(selection.anchorNode) ? selection.getRangeAt(0).cloneRange() : document.createRange();
    if (!selection?.rangeCount || !editor.contains(selection.anchorNode)) { range.selectNodeContents(editor); range.collapse(false); }
    for (const file of files) {
      if (!IMAGE_TYPES.has(file.type)) { onError("Paste a PNG, JPEG, WebP, or GIF image."); continue; }
      if (file.size > MAX_IMAGE_BYTES) { onError("That image is larger than 8 MB."); continue; }
      try {
        const dataUrl = await fileAsDataUrl(file);
        const dimensions = await imageDimensions(dataUrl);
        const error = fitError(dimensions.width, dimensions.height, 5);
        if (error) { onError(error); continue; }
        const image = imageElement({ type: "image", dataUrl, naturalWidth: dimensions.width, naturalHeight: dimensions.height, lines: 5 }, lineHeight());
        range.deleteContents();
        range.insertNode(image);
        const spacer = document.createTextNode("\u200b");
        image.after(spacer);
        range.setStartAfter(spacer); range.collapse(true);
        selectImage(image);
      } catch (reason) { onError(reason instanceof Error ? reason.message : "Could not paste this image."); }
    }
    selection?.removeAllRanges(); selection?.addRange(range);
    emitChange();
  };

  return <div className="rich-details-wrap">
    <div
      ref={editorRef}
      className="rich-details-editor"
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label="Additional details"
      data-placeholder={placeholder ?? "Commands, explanation, study notes, or pasted images…"}
      onInput={emitChange}
      onClick={(event) => {
        const target = event.target;
        if (target instanceof HTMLImageElement && target.dataset.detailImage === "true") selectImage(target);
        else setSelectedImage(null);
      }}
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") return;
        if (event.key === "Enter") { event.preventDefault(); insertLineBreak(); return; }
        if ((event.key === "Delete" || event.key === "Backspace") && selectedImage?.isConnected) {
          event.preventDefault(); selectedImage.remove(); setSelectedImage(null); emitChange();
        }
      }}
      onPaste={(event) => {
        const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
        event.preventDefault();
        if (images.length) void pasteImages(images);
        else insertText(event.clipboardData.getData("text/plain"));
      }}
    />
    <div className={`rich-image-presets ${selectedImage?.isConnected ? "is-visible" : ""}`} aria-hidden={!selectedImage?.isConnected}>
      <span>Image height</span>{LINE_PRESETS.map((lines) => <button type="button" key={lines} className={Number(selectedImage?.dataset.lines) === lines ? "is-active" : ""} onClick={() => resizeSelected(lines)}>{lines} lines</button>)}<label>Custom <input type="number" min="1" max="50" step="1" value={customLines} onChange={(event) => setCustomLines(event.target.value)} onBlur={applyCustomLines} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); applyCustomLines(); } }} /> lines</label>
    </div>
  </div>;
});

export function RichDetailsContent({ document, text, className = "" }: { document: DetailsDocument | null | undefined; text: string; className?: string }) {
  if (!document?.nodes.length) return <span className={className}>{text}</span>;
  return <span className={`rich-details-content ${className}`.trim()}>{document.nodes.map((node, index) => node.type === "text"
    ? <span key={index}>{node.text}</span>
    : <img key={index} src={node.dataUrl} alt="Pasted detail" data-lines={node.lines} style={{ height: `${node.lines * 1.2}em` }} />)}</span>;
}
