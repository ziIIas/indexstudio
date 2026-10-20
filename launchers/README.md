# Platform launchers — Index Studio 1.0.0

Install Node.js 24 LTS or newer, including npm, before using the source project. Launchers resolve the project relative to their own location, so you can run them from any working directory, including paths with spaces.

| Platform | First-time source setup | Start | Stop |
|---|---|---|---|
| Windows | Double-click `windows/Setup.cmd` | `windows/Start.cmd` | `windows/Stop.cmd` |
| macOS | Double-click `macos/Setup.command` | `macos/Start.command` | `macos/Stop.command` |
| Linux | `bash launchers/linux/setup.sh` | `bash launchers/linux/start.sh` | `bash launchers/linux/stop.sh` |

Linux commands above run from the repo root. GUI launchers can be opened directly from their platform folder. Keep the launcher folders inside the repository; do not copy an individual file to another location.

The same terminal commands work on all three platforms, from the repo root:

```text
npm run setup
npm run launch
npm run status
npm run stop
```

`setup` downloads locked dependencies and builds once. `launch` starts the app in the background and opens the browser. `status` prints whether your instance is running (exit code 0 when running, 1 otherwise). `stop` shuts down that instance safely. `npm start` is an alternative that keeps the server in the current terminal; stop it with Ctrl+C.

The `ready-to-run/index-studio-1.0.0/` folder in the consolidated release archive already contains the build, so setup and npm are unnecessary there. Its top level provides `Start.cmd`/`Stop.cmd`, `Start.command`/`Stop.command` and `start.sh`/`stop.sh`. These wrappers all call the same Node launcher. Keep `app/` beside them.

Optional settings are `INDEX_APP_DATA_DIR`, `INDEX_APP_PORT`, and `INDEX_APP_NO_OPEN=1`. Set them consistently for start, status and stop. The server stays bound to loopback, and normal API routes require no login or API key.
