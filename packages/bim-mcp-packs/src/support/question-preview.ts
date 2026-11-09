import { executeCommand, withUpgradePolicy, type Actor, type Command, type ModelState } from "@permitzip/bim-kernel"
import { agentActor } from "@permitzip/bim-sync"
import type { BimCaller } from "@permitzip/bim-mcp"

/**
 * An agent's preview of a question command decided the way the model server
 * will: with the session's advertised features (a server without question
 * threads refuses a reply in words) and the agent's own identity (who asked,
 * who replied; only the asker or their agent asks again). Nothing is sent.
 */
export function previewQuestionCommand(model: ModelState, command: Command, caller: Pick<BimCaller, "userId" | "runId" | "agentName" | "asPerson">, policy: (feature: string) => boolean): ReturnType<typeof executeCommand> {
  const actor: Actor = caller.asPerson ? { id: caller.userId, name: caller.agentName.slice(0, 80) || "Person", kind: "human" } : agentActor(caller.userId, caller.runId, caller.agentName)
  return withUpgradePolicy(policy, () => executeCommand(model, command, { actorId: actor.id, actor }))
}
