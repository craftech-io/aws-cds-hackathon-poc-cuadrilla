// What the BFF needs to know about the Cognito pool, read from the `Auth` link of infra/auth.ts
// (`Resource.Auth`, never `process.env`). The link grants no IAM permission and none is needed: id
// tokens are verified offline against the pool's public JWKS (auth/jwt.ts).
//
// The verifier derives the issuer, and with it the only JWKS it fetches, from the pool id. The linked
// `issuerUrl` must be that same issuer: a link that names another one is a misconfiguration and fails
// closed instead of trusting either value.
import { z } from "zod";
import { readLinked } from "../lib/resource";

/** Issuer of a Cognito user pool: the pool id starts with its region (`us-east-1_AbC123`). */
export function cognitoIssuer(userPoolId: string): string {
  const region = userPoolId.slice(0, userPoolId.indexOf("_"));
  return `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
}

const AuthResource = z
  .object({
    userPoolId: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d_[0-9A-Za-z]+$/),
    clientId: z.string().min(1),
    issuerUrl: z.url(),
    region: z.string().min(1),
  })
  .refine((auth) => auth.userPoolId.startsWith(`${auth.region}_`) && auth.issuerUrl === cognitoIssuer(auth.userPoolId), {
    message: "the linked issuer is not the issuer of the linked user pool",
  });
export type AuthConfig = z.infer<typeof AuthResource>;

export function authConfig(): AuthConfig {
  return readLinked("Auth", AuthResource);
}
