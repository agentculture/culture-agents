// Child process for daemon tests: runs the real `main` against the fake service. Config comes from the
// environment (CULTURE_AGENTS_SOCKET, XDG_CONFIG_HOME). Prints READY once listening.
import { main } from "../../src/daemon/main.js";
import { FakeRunService } from "./fake-service.js";

const code = await main(new FakeRunService(), {
  node: "spark",
  stderr: (line) => process.stderr.write(`${line}\n`),
});
process.exit(code);
