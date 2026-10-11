/** CLI-only entrypoint: Wrangler runs this in an authenticated, temporary preview.
 * It is never exported by Cody's application Worker or deployed to a public route.
 */
import {
  commandSchema,
  MAX_TRANSFER_BYTES,
  TRANSFER_VERSION,
  TransferError,
  transferFailure,
} from "../src/transfer/protocol.ts";
import { z } from "zod";
import { TransferService } from "../src/transfer/service.ts";
import { cloudflareTransferObjects } from "../src/transfer/cloudflare.ts";
import { equalSecret } from "../src/shared/equal-secret.ts";
import { readBodyWithinLimit } from "../src/gateway/http/body.ts";

type BridgeEnv = Env & { BRIDGE_TOKEN: string };
const probeSchema = z.strictObject({
  version: z.number().int().positive(),
  proof: z.string().regex(/^[a-f0-9]{64}$/),
});
const PROBE_STEP = "Cloudflare preflight / deployed Worker transferProbe RPC";

export default {
  async fetch(request: Request, env: BridgeEnv): Promise<Response> {
    if (
      request.method !== "POST" ||
      !(await equalSecret(
        request.headers.get("authorization") ?? "",
        `Bearer ${env.BRIDGE_TOKEN}`,
      ))
    )
      return new Response(null, { status: 404 });
    let step = "Transfer request decoding";
    try {
      const bytes = await readBodyWithinLimit(
        request.body,
        MAX_TRANSFER_BYTES,
        request.headers.get("content-length"),
      );
      const command = commandSchema.parse(
        JSON.parse(new TextDecoder().decode(bytes)),
      );
      if (command.action === "read" || command.action === "write")
        throw new TransferError("D1 data must use Wrangler file export/import");
      const service = new TransferService(
        env,
        cloudflareTransferObjects(env),
        "cloudflare",
      );
      if (command.action === "preflight") {
        // A preview runs local code, but its DO bindings execute the deployed code.
        // Check that release before accessing SQL or any business object state.
        step = PROBE_STEP;
        const probe = probeSchema.parse(
          await env.HEALTH.getByName("_transfer:probe").transferProbe(
            command.challenge,
          ),
        );
        if (probe.version !== TRANSFER_VERSION)
          throw new TransferError("Deployed Worker transfer protocol differs");
        step = "Cloudflare preflight";
        const result = await service.execute(command);
        if (probe.proof !== result.key_proof)
          throw new TransferError("Deployed Worker encryption key differs");
        return Response.json(result);
      }
      step = "Cloudflare transfer";
      const result = await service.execute(command);
      return Response.json(result);
    } catch (error) {
      const failure =
        error instanceof TransferError ? error : transferFailure(error, step);
      return Response.json(
        {
          error:
            failure.message +
            (step === PROBE_STEP
              ? ". Check the HEALTH binding and deploy the selected Worker from the same Cody release as this CLI; updating the local checkout alone does not update deployed Durable Objects."
              : ""),
        },
        { status: failure.status },
      );
    }
  },
};
