import { FestoClient, FestoError, loginAccount, validateToken } from "@/lib/festo/client";
import { NO_STORE, readBody, errorResponse } from "@/lib/festo/http";
import { handleUnifiedApiRequest } from "@/server/unifiedBackend.js";

export async function POST(request: Request) {
  let stage = "Connection setup";
  try {
    const body = await readBody(request);
    // Disambiguate MSE6-C2M device connection requests ({ host, port, unit, poll })
    // from Smartenance API authentication requests ({ mode: 'token' | 'account', ... })
    if (body && typeof body.host === "string" && !body.mode) {
      return handleUnifiedApiRequest(request, body);
    }
    if (!body || !["token", "account"].includes(body.mode))
      throw new FestoError("Select a connection method.", 400);
    stage = body.mode === "account" ? "Account sign-in" : "Token validation";
    const auth =
      body.mode === "account"
        ? await loginAccount(body.username, body.password, body.policy)
        : { token: validateToken(body.token), expiresIn: null };
    stage = "Loading machines";
    const machines = await new FestoClient(auth.token, {
      signal: request.signal,
    }).machines();
    return Response.json({ ...auth, machines }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof FestoError)
      return errorResponse(new FestoError(`${stage} failed: ${error.message}`, error.status));
    return errorResponse(error);
  }
}
