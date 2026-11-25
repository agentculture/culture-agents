// Child process for daemon tests: runs the real `main` against the fake service. Config comes from the
// environment (CULTURE_AGENTS_SOCKET, XDG_CONFIG_HOME). Prints READY once listening. SIGUSR2 throws from
// a callback and SIGUSR1 leaves a rejection unhandled, so tests can drive the fatal-error handlers.
import { main } from "../../src/daemon/main.js";
import { FakeRunService } from "./fake-service.js";

process.on("SIGUSR2", () => {
  throw new Error("boom from a callback");
});
process.on("SIGUSR1", () => void Promise.reject(new Error("rejected and never handled")));

const code = await main(new FakeRunService(), {
  node: "spark",
  stderr: (line) => process.stderr.write(`${line}\n`),
  fatalHandlers: true,
});
process.exit(code);
