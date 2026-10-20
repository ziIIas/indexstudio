import apiReference from "../../docs/API.md?raw";

export function ApiView() {
  return <article className="markdown-document"><pre>{apiReference}</pre></article>;
}
