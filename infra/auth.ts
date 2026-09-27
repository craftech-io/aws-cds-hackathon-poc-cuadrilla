import {
  CONSOLE_GROUPS,
  CONSOLE_GROUP_NAMES,
  LOGIN_PATH,
  NEUTRAL_EMAIL_BRAND,
  POOL_CLIENTS,
  WEB_ENV_NAMES,
  cognitoMessages,
  emailSenderFor,
  userPoolSettings,
  type ConsoleGroup,
  type EmailConfiguration,
  type EmailSenderChoice,
} from "./auth-email";
import { CostCaps } from "./cost-caps";
import { appDomain, appUrl } from "./dns";
import { guestWorlds } from "./guest-worlds";
import { Leads, grantTableLinks, signupPermissions } from "./leads";
import { SIGNUP_HANDLERS, TRIGGER_BUDGET, type SignupFunction } from "./leads-spec";
import { SessionTokenKey } from "./secrets";
import { storageLinks, storagePermissions } from "./storage";

/** Handler of the pre token trigger (WP-13); the path is the contract with packages/bff. */
export const PRE_TOKEN_HANDLER = "packages/bff/src/auth-triggers/pre-token.handler";

function applySender(choice: EmailSenderChoice): EmailConfiguration {
  if (choice.warning) $util.log.warn(choice.warning);
  return choice.configuration;
}

// The identity is read live on every deploy: the resource's own state would keep the "not verified
// yet" of its creation. `dependsOn` skips the read while the identity is still being created.
function senderConfiguration(identity: unknown): $util.Output<EmailConfiguration> {
  if (identity === undefined) return $util.output(applySender(emailSenderFor(undefined, appDomain)));
  if (!aws.sesv2.EmailIdentity.isInstance(identity)) {
    throw new Error("infra/messaging-email.ts exports emailIdentity, but it is not an aws.sesv2.EmailIdentity.");
  }
  return aws.sesv2
    .getEmailIdentityOutput({ emailIdentity: identity.emailIdentity }, { dependsOn: [identity] })
    .apply((live) => applySender(emailSenderFor({ domain: live.emailIdentity, arn: live.arn, verified: live.verifiedForSendingStatus }, appDomain)));
}

// The SES identity belongs to infra/messaging-email.ts, which may be evaluated after this module. A
// dynamic import inside an Output settles once that module has run, whatever the order.
const emailConfiguration = $util.output(import("./messaging-email").then((module) => senderConfiguration(Reflect.get(module, "emailIdentity"))));

// The neutral brand in every mode of BrandConfig: these go to addresses nobody verified (ADR-0025 §1).
const messages = cognitoMessages({ loginUrl: `${appUrl}${LOGIN_PATH}`, brandUrl: `${appUrl}/brand`, brand: NEUTRAL_EMAIL_BRAND });

/** Stamps `ispId`, the role and `isGuest` on the tokens from `Isps/USER#`; audits a differing `custom:ispId`. */
export const preTokenTrigger = new sst.aws.Function("AuthPreToken", {
  description: "Cognito pre token generation (V2_0): ispId, role and isGuest from Isps/USER#.",
  handler: PRE_TOKEN_HANDLER,
  link: storageLinks("AuthPreToken"),
  permissions: storagePermissions("AuthPreToken"),
  timeout: `${TRIGGER_BUDGET.timeoutSeconds} seconds`,
  memory: `${TRIGGER_BUDGET.memoryMb} MB`,
});

/** The Lambdas each trigger of the flow links besides `Runtime` (always fenced by its grants). */
const TRIGGER_LINKS = {
  AuthPreSignUp: [Leads, SessionTokenKey],
  AuthCustomMessage: [],
  AuthPostConfirmation: [Leads, SessionTokenKey, CostCaps, guestWorlds],
  AuthPostAuthentication: [Leads, SessionTokenKey, CostCaps, guestWorlds],
} as const;

type SignupTrigger = keyof typeof TRIGGER_LINKS & SignupFunction;

const TRIGGER_DESCRIPTIONS: Readonly<Record<SignupTrigger, string>> = {
  AuthPreSignUp: "Cognito pre sign-up: only SignUp with a valid ticket and AdminCreateUser; never confirms.",
  AuthCustomMessage: "Cognito custom message: the neutral es-MX/en authentication emails; none while the sign-up is cut.",
  AuthPostConfirmation: "Cognito post confirmation: a gst-* user with a pending lead becomes a GUEST with a world.",
  AuthPostAuthentication: "Cognito post authentication: last login, lead retention and a new world generation when due.",
};

function trigger(name: SignupTrigger): sst.aws.Function {
  return new sst.aws.Function(name, {
    description: TRIGGER_DESCRIPTIONS[name],
    handler: SIGNUP_HANDLERS[name],
    // `Runtime` and `Isps` by name only; every access is a fenced grant of the trigger's row.
    link: [...storageLinks(name), ...grantTableLinks(name), ...TRIGGER_LINKS[name]],
    permissions: [...storagePermissions(name), ...signupPermissions(name)],
    timeout: `${TRIGGER_BUDGET.timeoutSeconds} seconds`,
    memory: `${TRIGGER_BUDGET.memoryMb} MB`,
  });
}

export const preSignUpTrigger = trigger("AuthPreSignUp");
export const customMessageTrigger = trigger("AuthCustomMessage");
export const postConfirmationTrigger = trigger("AuthPostConfirmation");
export const postAuthenticationTrigger = trigger("AuthPostAuthentication");

export const userPool = new sst.aws.CognitoUserPool("UserPool", {
  aliases: ["email"],
  mfa: "optional",
  softwareToken: true,
  triggers: {
    preSignUp: preSignUpTrigger.arn,
    customMessage: customMessageTrigger.arn,
    postConfirmation: postConfirmationTrigger.arn,
    postAuthentication: postAuthenticationTrigger.arn,
    preTokenGeneration: preTokenTrigger.arn,
    // V2_0 also shapes the access token; it needs the ESSENTIALS feature plan (userPoolSettings).
    preTokenGenerationVersion: "v2",
  },
  transform: {
    userPool: {
      ...userPoolSettings(),
      ...messages,
      emailConfiguration,
    },
  },
});

export const userGroups = Object.fromEntries(
  CONSOLE_GROUP_NAMES.map((group) => [
    group,
    new aws.cognito.UserGroup(`UserPoolGroup${group.charAt(0)}${group.slice(1).toLowerCase()}`, {
      userPoolId: userPool.id,
      name: group,
      precedence: CONSOLE_GROUPS[group].precedence,
      description: CONSOLE_GROUPS[group].description,
    }),
  ]),
) as Record<ConsoleGroup, aws.cognito.UserGroup>;

export const webClient = userPool.addClient("ConsoleWeb", { transform: { client: POOL_CLIENTS.ConsoleWeb } });
export const guestSignupClient = userPool.addClient("GuestSignup", { transform: { client: POOL_CLIENTS.GuestSignup } });
export const qaProbeClient = userPool.addClient("QaProbe", { transform: { client: POOL_CLIENTS.QaProbe } });

const region = aws.getRegionOutput({}).region;

/** OIDC issuer of the pool; the BFF verifies id tokens offline against `<issuer>/.well-known/jwks.json`. */
export const issuerUrl = $interpolate`https://cognito-idp.${region}.amazonaws.com/${userPool.id}`;

/** What a Lambda needs to know about the pool (packages/bff/src/auth/config.ts, `readLinked("Auth", …)`); no IAM grant. */
export const Auth = new sst.Linkable("Auth", {
  properties: {
    userPoolId: userPool.id,
    clientId: webClient.id,
    issuerUrl,
    region,
  },
});

/**
 * Build-time variables of the console (infra/web.ts passes them to the StaticSite; Vite exposes the
 * `VITE_` prefix to the browser). None is a secret: the clients are public and the pool id is part
 * of every token; the region of the Cognito API is the prefix of the pool id.
 */
export const authWebEnvironment: Record<string, $util.Input<string>> = {
  [WEB_ENV_NAMES.userPoolId]: userPool.id,
  [WEB_ENV_NAMES.clientId]: webClient.id,
  [WEB_ENV_NAMES.signupClientId]: guestSignupClient.id,
};
