import { readFile } from "node:fs/promises";
import { readFixture } from "@cloudreve/testkit/community";
import { AccountClient, Authentication } from "@cloudreve/sdk/session";

export async function fixture() {
  const path = process.env.CR_FIXTURE_MANIFEST;

  if (!path) {
    throw Error(
      "Set CR_FIXTURE_MANIFEST or use mise run test:e2e to provision an isolated Community server",
    );
  }

  const input = JSON.parse(await readFile(path, "utf8"));

  return readFixture(path, input.owner);
}

export async function communityClient(secondary = false) {
  const f = await fixture();

  const credentials = JSON.parse(
    await readFile(secondary ? f.secondaryCredentialsFile : f.credentialsFile, "utf8"),
  );

  const result = await new Authentication(f.endpoint, fetch).password(
    credentials.email,
    credentials.password,
  );

  if (result.kind !== "authenticated") {
    throw Error("Fixture requires supported password login");
  }

  const { token, user } = result.session;

  let tokens = {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    accessExpiresAt: Date.parse(token.access_expires),
    refreshExpiresAt: Date.parse(token.refresh_expires),
  };

  return new AccountClient({
    accountId: user.id,
    endpoint: f.endpoint,
    transport: fetch,
    tokens: () => tokens,
    saveTokens: (next) => {
      tokens = next;
    },
  });
}

export async function proofSource(prefix) {
  const { Files } = await import("@cloudreve/sdk/files");

  const client = await communityClient();
  const files = new Files(client);

  const created = await files.create("cloudreve://my/", `sdk-${prefix}-${Date.now()}.txt`, "file");
  const text = "SDK proof 中文\n".repeat(1000);

  try {
    const source = await files.saveText(await files.readText(created.path, fetch), text);

    return { client, files, source, bytes: new TextEncoder().encode(text) };
  } catch (error) {
    await files.delete([created.path], true);

    throw error;
  }
}
