// What the BFF needs to know about the Cognito pool, read from the `Auth` link of infra/auth.ts
// (`Resource.Auth`, never `process.env`). Token verification needs no IAM permission: the JWKS is
// public; AdminGetUser rides on the permissions the link includes.
import { z } from "zod";
import { readLinked } from "../lib/resource";

const AuthResource = z.object({
  userPoolId: z.string().min(1),
  clientId: z.string().min(1),
  issuerUrl: z.string().url(),
  region: z.string().min(1),
});
export type AuthConfig = z.infer<typeof AuthResource>;

export function authConfig(): AuthConfig {
  return readLinked("Auth", AuthResource);
}
