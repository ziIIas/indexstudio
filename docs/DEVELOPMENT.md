# Development â€” Index Studio 1.0.0

Use Node.js 24 LTS or newer. Run all commands from the source project folder.

```bash
npm run setup   # Install locked dependencies and build once
npm run launch  # Start the local app in the background
npm run status  # Check whether the app is running
npm run stop    # Stop the local app
npm start       # Alternatively run the server in this terminal
npm run build   # Rebuild after UI changes
npm test        # Run the automated checks (build first)
npm run check   # Build and test together
npm run release # Build, test and make both clean downloads
```

The production server serves `dist/`. `npm run dev` starts an optional Vite development server; its alternate origin is intentionally not allowed by the production API. Use the production URL when checking the full app.

## Releases

`npm run release` generates two archives in `releases/`:

- **index-studio-VERSION.tar.gz** â€” the ready-to-run app. Its top level has the short README, Windows and macOS Start/Stop launchers, Linux start/stop scripts, `app/` and `docs/API.md`. The README includes the user guide and security defaults.
- **index-studio-VERSION-source.tar.gz** â€” clean source for developers, including tests and build tools. No dependencies, build output or personal files.

Each generated archive has a `.sha256` checksum. The source folder is the Git repository. GitHub releases publish the ready-to-run `index-studio-VERSION.tar.gz` and its checksum; generated archives and builds are ignored by Git. The source packaging command also produces a clean source archive locally. Extracted staging copies are grouped under `releases/ready-to-run/` and `releases/source/`. Runtime checksums are in `app/manifest.json`; source checksums are in `SOURCE-MANIFEST.json`.

Source files are selected by exact path in `config/release-files.json`. The runtime mapping is explicit in `scripts/release.mjs`. Symlinks, local data folders, private imports and database files are rejected. To add a new source file, review it and add its path to the allowlist. Never distribute a zip of the personal working directory.

To extract and verify the generated app archive with native platform paths, run `node scripts/verify-archive.mjs`. It uses a temporary path containing spaces on every platform and Windows' native tar utility on Windows. An optional first argument selects another archive.

To verify an already extracted app without dependencies:

```bash
node scripts/verify-release.mjs /path/to/extracted/index-studio-VERSION
```

The verifier checks every packaged file, starts with temporary empty storage, exercises the API, checks start/stop and confirms data survives a restart. It does not use your real storage. GitHub Actions runs build, audit, tests, packaging and this check on Windows, Ubuntu and both Apple Silicon and Intel macOS. Native platform results are available only after those jobs run.

## Private local material

In a personal working checkout, existing `data/`, `seed/` and `exports/` folders may remain in place to avoid disturbing an old installation. These folders are absent from this clean source distribution. Loose personal imports are grouped in `private/imports/`; historical planning notes are in `docs/archive/`. All are ignored by Git and excluded from releases. New app storage lives in the per-user location described in the user guide.

See [the platform launcher guide](../launchers/README.md) for setup and launch shortcuts on every OS. `.gitattributes` preserves LF for shell scripts and CRLF for Windows command files when checked out with Git. Existing private legacy folders remain in place so any older installation can still find them.

## Publish v1.0.0 to GitHub

The source repository has one `init` commit on `main` and a `v1.0.0` tag. Create an empty GitHub repository, then run these commands from this source folder, replacing the URL with your repository URL:

```bash
git remote add origin https://github.com/OWNER/REPOSITORY.git
git push -u origin main
git push origin v1.0.0
```

The Checks and releases workflow builds and verifies the application on each configured platform. After all checks pass for the tag, it creates a GitHub release with the ready-to-run `.tar.gz` and `.sha256` attached. Source, runtime and archive version labels must match the tag. The workflow requires GitHub Actions to be enabled; no custom token or secret is needed.
