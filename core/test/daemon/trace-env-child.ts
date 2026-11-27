// Child for trace-env.test.ts: the real `main` with trace keys in its environment. The first request the
// service sees reports how many CULTURE_AGENTS_TRACE_ variables the core still holds at that point.
import { main } from "../../src/daemon/main.js";
import type { AgentList } from "../../src/contract/index.js";
import { FakeRunService } from "./fake-service.js";

class Probe extends FakeRunService {
  override listAgents(): Promise<AgentList> {
    const left = Object.keys(process.env).filter((k) => k.startsWith("CULTURE_AGENTS_TRACE_")).length;
    process.stderr.write(`TRACE_VARS_LEFT=${left}\n`);
    return super.listAgents();
  }
}

process.exit(await main(new Probe(), { node: "thor", stderr: (line) => process.stderr.write(`${line}\n`), fatalHandlers: true }));
