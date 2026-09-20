import {
  ApiError,
  assertNotAborted,
  decode,
  request,
  waitFor,
  withDeadline,
  type RequestOptions,
  type ResponseConsumer,
  type Transport,
} from "../protocol/index.ts";
import {
  SessionRecordSchema,
  tokensFromPassword,
  type Tokens,
  type SessionRecord,
} from "./tokens.ts";
import type { PasswordLoginToken } from "./auth-types.ts";

export {
  tokensFromPassword,
  tokensFromOAuth,
  TokensSchema,
  SessionRecordSchema,
} from "./tokens.ts";

/** @public */
export type { Tokens, SessionRecord } from "./tokens.ts";

/** @public */
export interface SessionStore {
  /** Durable negative marker; must be generation-specific and safe outside the credential lease. */
  invalidate?(generation: string): void | Promise<void>;
  read(): Promise<SessionRecord>;
  write(record: SessionRecord): Promise<void>;
}

/** @public */
export type SessionExclusive = <T>(operation: () => Promise<T>, signal?: AbortSignal) => Promise<T>;

/** @public */
export interface SessionSnapshot {
  status: "loading" | "authenticated" | "signedOut" | "refreshing" | "invalidated";
  generation?: string;
  accountId: string;
  endpoint: string;
}

/** Account identity, transport, and credential persistence supplied by the host. @public */
export interface SessionOptions {
  readonly accountId: string;
  readonly generation?: string;
  readonly endpoint: string;
  transport: Transport;
  store?: SessionStore;
  exclusive?: SessionExclusive;
  tokens?: () => Tokens | null;
  saveTokens?: (tokens: Tokens, lifetime: AbortSignal) => void | Promise<void>;
  now?: () => number;
  timeoutMs?: number;
}

/** One coordinator for either platform transactions or the legacy callback adapter. */
class SessionCoordinator {
  readonly lifetime = new AbortController();
  private refresh: Promise<string> | null = null;
  private initialized: Promise<void> | undefined;
  private generation: string | undefined;
  private lastRecord: SessionRecord | undefined;
  private state: SessionSnapshot;
  private listeners = new Set<() => void>();
  private store: SessionStore;
  private exclusive: SessionExclusive;

  constructor(
    private options: SessionOptions,
    endpoint: string,
  ) {
    this.generation = options.generation;
    this.state = { status: "loading", accountId: options.accountId, endpoint };

    if (options.store && !options.exclusive) {
      throw new ApiError(-1, "Session store requires an exclusive transaction");
    }

    if (!options.store && (!options.tokens || !options.saveTokens)) {
      throw new ApiError(-1, "Provide a session store or token callbacks");
    }

    this.store = options.store ?? {
      read: async () => ({ generation: "legacy", tokens: options.tokens!() }),
      write: async (record) => {
        if (!record.tokens) {
          throw new ApiError(
            -1,
            "Legacy session logout requires platform credential removal",
            undefined,
            undefined,
            undefined,
            { kind: "unsupported" },
          );
        }

        await options.saveTokens!(record.tokens, this.lifetime.signal);
      },
    };

    this.exclusive = options.exclusive ?? (async (operation) => operation());
  }

  private publish(status: SessionSnapshot["status"]) {
    this.state = { ...this.state, status, generation: this.generation };
    this.listeners.forEach((listener) => listener());
  }

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  };

  private async read() {
    try {
      const record = decode(SessionRecordSchema, await this.store.read(), "Invalid saved session");

      this.lastRecord = record;

      return record;
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }

      throw new ApiError(-1, "Unable to read session storage", undefined, undefined, undefined, {
        kind: "storage",
        cause: error,
      });
    }
  }

  ready(): Promise<void> {
    this.initialized ??= this.read().then((record) => {
      if (this.generation !== undefined && this.generation !== record.generation) {
        this.invalidate();

        throw new ApiError(401, "Session generation changed", undefined, undefined, undefined, {
          kind: "authentication",
        });
      }

      this.generation = record.generation;

      if (!this.lifetime.signal.aborted) {
        this.publish(
          record.tokens && record.tokens.refreshExpiresAt > (this.options.now?.() ?? Date.now())
            ? "authenticated"
            : "signedOut",
        );
      }
    });

    return this.initialized;
  }

  invalidate() {
    this.lifetime.abort(
      new ApiError(401, "Session ended", undefined, undefined, undefined, {
        kind: "authentication",
      }),
    );

    this.publish("invalidated");
  }

  authenticationFailed() {
    if (!this.lifetime.signal.aborted) {
      this.publish("signedOut");
    }
  }

  private active(record: SessionRecord): Tokens {
    if (record.generation !== this.generation) {
      this.invalidate();

      throw new ApiError(401, "Session ended", undefined, undefined, undefined, {
        kind: "authentication",
      });
    }

    if (!record.tokens) {
      this.authenticationFailed();
    }

    if (this.lifetime.signal.aborted || !record.tokens || this.state.status === "signedOut") {
      throw new ApiError(
        401,
        record.tokens && record.tokens.refreshExpiresAt <= (this.options.now?.() ?? Date.now())
          ? "Session expired"
          : "Session ended",
        undefined,
        undefined,
        undefined,
        { kind: "authentication" },
      );
    }

    return record.tokens;
  }

  async access(force = false, rejected?: string): Promise<string> {
    await this.ready();

    const record = await this.read();
    const tokens = this.active(record);

    if (rejected && tokens.accessToken !== rejected) {
      return tokens.accessToken;
    }

    if (!force && tokens.accessExpiresAt > (this.options.now?.() ?? Date.now()) + 30_000) {
      return tokens.accessToken;
    }

    if (!this.refresh) {
      this.publish("refreshing");

      this.refresh = withDeadline(
        async (signal) =>
          this.exclusive(async () => {
            assertNotAborted(signal);

            const current = await waitFor(this.read(), signal);
            const fresh = this.active(current);

            if (
              fresh.accessToken !== tokens.accessToken ||
              (!force && fresh.accessExpiresAt > (this.options.now?.() ?? Date.now()) + 30_000)
            ) {
              return fresh.accessToken;
            }

            if (fresh.refreshExpiresAt <= (this.options.now?.() ?? Date.now())) {
              throw new ApiError(401, "Session expired", undefined, undefined, undefined, {
                kind: "authentication",
              });
            }

            const result = await request<PasswordLoginToken>(
              this.options.transport,
              `${this.state.endpoint}/api/v4/session/token/refresh`,
              {
                method: "POST",
                body: JSON.stringify({ refresh_token: fresh.refreshToken }),
                signal,
                timeoutMs: 0,
                retry: "never",
                redirect: "error",
              },
            );

            const updated = tokensFromPassword(result);

            assertNotAborted(signal);
            this.active(await waitFor(this.read(), signal));

            try {
              await this.store.write({
                generation: current.generation,
                tokens: updated,
              });
            } catch (error) {
              if (this.lifetime.signal.aborted) {
                throw new ApiError(401, "Session ended");
              }

              throw new ApiError(
                -1,
                error instanceof Error ? error.message : "Unable to save session",
                undefined,
                undefined,
                undefined,
                { kind: "storage", cause: error },
              );
            }

            assertNotAborted(signal);
            this.active(await waitFor(this.read(), signal));

            return updated.accessToken;
          }, signal),
        { timeoutMs: this.options.timeoutMs },
        this.lifetime.signal,
      )
        .then(
          (token) => {
            if (!this.lifetime.signal.aborted) {
              this.publish("authenticated");
            }

            return token;
          },
          (error) => {
            if (!this.lifetime.signal.aborted) {
              this.publish(
                error instanceof ApiError && [401, 40020].includes(error.code)
                  ? "signedOut"
                  : "authenticated",
              );
            }

            throw error;
          },
        )
        .finally(() => {
          this.refresh = null;
        });
    }

    return this.refresh;
  }

  async logout(options: { revoke?: boolean } = {}): Promise<void> {
    this.invalidate();

    if (this.generation === undefined) {
      return;
    }

    const previousToken =
      this.lastRecord?.generation === this.generation
        ? this.lastRecord.tokens?.refreshToken
        : undefined;

    let refreshToken: string | undefined;

    try {
      refreshToken = await withDeadline(
        async (signal) => {
          await waitFor(Promise.resolve(this.store.invalidate?.(this.generation!)), signal);

          return this.exclusive(async () => {
            const record = await this.read();

            if (record.generation !== this.generation) {
              return;
            }

            try {
              await this.store.write({ ...record, tokens: null });
            } catch (error) {
              if (error instanceof ApiError) {
                throw error;
              }

              throw new ApiError(
                -1,
                error instanceof Error ? error.message : "Unable to clear session",
                undefined,
                undefined,
                undefined,
                { kind: "storage", cause: error },
              );
            }

            return record.tokens?.refreshToken ?? previousToken;
          }, signal);
        },
        { timeoutMs: this.options.timeoutMs },
      );
    } catch (error) {
      throw new ApiError(
        -1,
        error instanceof Error ? error.message : "Unable to persist logout",
        undefined,
        undefined,
        undefined,
        { kind: "storage", phase: "persistence", cause: error },
      );
    }

    if (options.revoke && refreshToken) {
      try {
        await request(this.options.transport, `${this.state.endpoint}/api/v4/session/token`, {
          method: "DELETE",
          body: JSON.stringify({ refresh_token: refreshToken }),
          timeoutMs: this.options.timeoutMs,
          retry: "never",
          redirect: "error",
        });
      } catch (error) {
        if (error instanceof ApiError) {
          throw new ApiError(
            error.code,
            error.message,
            error.correlationId,
            error.data,
            error.aggregatedError,
            {
              kind: error.kind,
              httpStatus: error.httpStatus,
              apiCode: error.apiCode,
              phase: "revocation",
              cause: error,
            },
          );
        }

        throw error;
      }
    }
  }
}

/** Account-bound public session and authenticated request entry. */
/** Authenticated requests with refresh, cancellation, and generation-bound persistence. @public */
export class AccountClient {
  readonly endpoint: string;
  readonly accountId: string;
  private coordinator: SessionCoordinator;

  constructor(private options: SessionOptions) {
    const url = new URL(options.endpoint);

    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new ApiError(-1, "Invalid server URL");
    }

    this.endpoint = url.origin;
    this.accountId = options.accountId;
    this.coordinator = new SessionCoordinator(options, this.endpoint);
  }

  get signal() {
    return this.coordinator.lifetime.signal;
  }

  ready = () =>
    withDeadline(
      (signal) => waitFor(this.coordinator.ready(), signal),
      { timeoutMs: this.options.timeoutMs },
      this.signal,
    );
  getSnapshot = () => this.coordinator.getSnapshot();
  subscribe = (listener: () => void) => this.coordinator.subscribe(listener);
  invalidate = () => this.coordinator.invalidate();
  logout = (options?: { revoke?: boolean }) => this.coordinator.logout(options);

  async request<T>(path: string, init: RequestOptions = {}, raw = false): Promise<T> {
    return this.execute<T>(path, init, raw);
  }

  /** Holds authentication, cancellation and deadline through complete response consumption. */
  async consume<T>(
    path: string,
    consumer: ResponseConsumer<T>,
    init: RequestOptions = {},
  ): Promise<T> {
    return this.execute(path, init, false, consumer);
  }

  private async execute<T>(
    path: string,
    init: RequestOptions,
    raw: boolean,
    consume?: ResponseConsumer<T>,
  ): Promise<T> {
    const url = new URL(path, this.endpoint);

    if (
      url.origin !== this.endpoint ||
      url.username ||
      url.password ||
      !url.pathname.startsWith("/api/v4/")
    ) {
      throw new ApiError(-1, "Untrusted authenticated destination");
    }

    return withDeadline(
      async (signal) => {
        let consumed = false;

        const send = async (token: string) => {
          assertNotAborted(signal);

          const headers = new Headers(init.headers);

          headers.set("Authorization", `Bearer ${token}`);

          const value = await request<T>(
            this.options.transport,
            url.toString(),
            { ...init, headers, signal, timeoutMs: 0, redirect: "error" },
            raw,
            consume
              ? (response, lifetime) => {
                  consumed = !!response.headers.get("Content-Type")?.includes("text/event-stream");

                  return consume(response, lifetime);
                }
              : undefined,
          );

          assertNotAborted(signal);

          return value;
        };

        const token = await waitFor(this.coordinator.access(), signal);

        try {
          return await send(token);
        } catch (error) {
          if (!(error instanceof ApiError) || ![401, 40020].includes(error.code)) {
            throw error;
          }

          const replayable = init.replayable ?? (!init.body || typeof init.body === "string");

          if (!replayable || consumed) {
            throw error;
          }

          try {
            return await send(await waitFor(this.coordinator.access(true, token), signal));
          } catch (error) {
            if (error instanceof ApiError && [401, 40020].includes(error.code)) {
              this.coordinator.authenticationFailed();
            }

            throw error;
          }
        }
      },
      { ...init, timeoutMs: init.timeoutMs ?? this.options.timeoutMs },
      this.signal,
    );
  }
}

export * from "./auth-types.ts";

export * from "./authentication.ts";

export * from "./server.ts";

export * from "./ceremony.ts";

export * from "./cli-oauth.ts";
