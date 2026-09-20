import { describe, it, expect, vi, beforeEach } from "vitest";
import { request, ApiError } from "@cloudreve/sdk/protocol";

const apiRequest = <T>(url: string, init: RequestInit = {}) => request<T>(fetch, url, init);

const rawRequest = <T>(url: string, init: RequestInit = {}) => request<T>(fetch, url, init, true);

describe("API Client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
  });

  describe("apiRequest", () => {
    it("returns data on success (code 0)", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ code: 0, data: { id: 1, name: "test" }, msg: "" }),
      } as Response);

      const result = await apiRequest<{ id: number; name: string }>("https://cloud.local.test/api");

      expect(result).toEqual({ id: 1, name: "test" });
    });

    it("throws ApiError on non-zero code", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          code: 40020,
          data: null,
          msg: "Credential invalid",
          correlation_id: "abc-123",
        }),
      } as Response);

      try {
        await apiRequest("https://cloud.local.test/api");
        expect.unreachable("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ApiError);

        const err = e as ApiError;

        expect(err.code).toBe(40020);
        expect(err.message).toBe("Credential invalid");
        expect(err.correlationId).toBe("abc-123");
      }
    });

    it("throws ApiError on HTTP error", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      } as Response);

      try {
        await apiRequest("https://cloud.local.test/api");
        expect.unreachable("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ApiError);
        expect((e as ApiError).code).toBe(500);
      }
    });

    it("uses error field when msg is empty", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          code: 500,
          data: null,
          msg: "",
          error: "internal failure",
        }),
      } as Response);

      await expect(apiRequest("https://cloud.local.test/api")).rejects.toThrow("internal failure");
    });

    it("falls back to Server operation failed when both msg and error are empty", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ code: 500, data: null, msg: "" }),
      } as Response);

      await expect(apiRequest("https://cloud.local.test/api")).rejects.toThrow(
        "Server operation failed",
      );
    });

    it("sets Content-Type to application/json", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ code: 0, data: null, msg: "" }),
      } as Response);

      await apiRequest("https://cloud.local.test/api");

      const [, options] = vi.mocked(fetch).mock.calls[0]!;

      expect(new Headers((options as RequestInit).headers).get("Content-Type")).toBe(
        "application/json",
      );
    });

    it("allows caller headers to override default Content-Type", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ code: 0, data: null, msg: "" }),
      } as Response);

      await apiRequest("https://cloud.local.test/api", {
        headers: { "Content-Type": "multipart/form-data" },
      });

      const [, options] = vi.mocked(fetch).mock.calls[0]!;

      expect(new Headers((options as RequestInit).headers).get("Content-Type")).toBe(
        "multipart/form-data",
      );
    });

    it("sets correlationId to undefined when absent from response", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ code: 500, data: null, msg: "Server error" }),
      } as Response);

      try {
        await apiRequest("https://cloud.local.test/api");
        expect.unreachable("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ApiError);
        expect((e as ApiError).correlationId).toBeUndefined();
      }
    });
  });

  describe("rawRequest", () => {
    it("returns raw JSON response", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ access_token: "at-123", token_type: "Bearer" }),
      } as Response);

      const result = await rawRequest<{ access_token: string }>("https://cloud.local.test/token");

      expect(result.access_token).toBe("at-123");
    });

    it("does not inject a default Content-Type header", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ data: "ok" }),
      } as Response);

      await rawRequest("https://cloud.local.test/token");

      const [, options] = vi.mocked(fetch).mock.calls[0]!;

      expect(new Headers((options as RequestInit).headers).get("Content-Type")).toBeNull();
    });

    it("throws on HTTP error with body text", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => '{"error":"invalid_grant"}',
      } as Response);

      await expect(rawRequest("https://cloud.local.test/token")).rejects.toThrow("invalid_grant");
    });

    it("falls back to HTTP status when response.text() throws", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 502,
        text: () => Promise.reject(new Error("stream consumed")),
      } as unknown as Response);

      await expect(rawRequest("https://cloud.local.test/token")).rejects.toThrow("HTTP 502");
    });
  });
});
