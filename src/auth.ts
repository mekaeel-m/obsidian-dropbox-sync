/**
 * Dropbox OAuth via PKCE, in the "no redirect URI" variant.
 *
 * Why this shape: a plugin is distributed source-readable to every user, so it
 * cannot hold a client secret. PKCE removes the need for one. And a redirect URI
 * would mean catching a browser redirect — easy on desktop Electron, genuinely
 * awkward inside Obsidian's mobile webview. Omitting `redirect_uri` makes
 * Dropbox render the authorization code on screen for the user to copy, which
 * works identically on every platform at the cost of one paste.
 *
 * `token_access_type=offline` is what earns us a refresh token; without it the
 * access token expires in four hours and sync silently stops.
 */

import { requestUrl } from "obsidian";
import { base64UrlEncode, errorMessage, randomId } from "./util";

const AUTHORIZE_URL = "https://www.dropbox.com/oauth2/authorize";
const TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";

/**
 * The permissions this plugin needs, which must *also* be enabled on the app's
 * Permissions tab in the Dropbox App Console — the scope string alone is not
 * enough, and a mismatch shows up as `missing_scope` on the first API call.
 */
export const REQUIRED_SCOPES = [
  "account_info.read",
  "files.metadata.read",
  "files.metadata.write",
  "files.content.read",
  "files.content.write",
].join(" ");

/** Refresh this many ms before actual expiry, so a long sync can't age out. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  account_id?: string;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly needsReauth = false,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

/** One in-flight PKCE attempt. Discarded once the code is exchanged. */
export class PkceFlow {
  private constructor(
    readonly verifier: string,
    readonly challenge: string,
    readonly appKey: string,
  ) {}

  static async begin(appKey: string): Promise<PkceFlow> {
    // 32 random bytes -> 43-char base64url verifier, the RFC 7636 sweet spot.
    const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier),
    );
    return new PkceFlow(verifier, base64UrlEncode(digest), appKey);
  }

  authorizeUrl(): string {
    const params = new URLSearchParams({
      client_id: this.appKey,
      response_type: "code",
      code_challenge: this.challenge,
      code_challenge_method: "S256",
      token_access_type: "offline",
      scope: REQUIRED_SCOPES,
    });
    return `${AUTHORIZE_URL}?${params.toString()}`;
  }

  /** Exchange the pasted authorization code for a refresh token. */
  async exchange(code: string): Promise<TokenResponse> {
    return postToken({
      code: code.trim(),
      grant_type: "authorization_code",
      client_id: this.appKey,
      code_verifier: this.verifier,
    });
  }
}

/**
 * Owns the access token's lifecycle. Everything that talks to Dropbox goes
 * through `getAccessToken()`, which refreshes on demand and collapses
 * concurrent refreshes into one request.
 */
export class AuthManager {
  private inFlight: Promise<string> | null = null;

  constructor(
    private readonly read: () => {
      appKey: string;
      refreshToken: string;
      accessToken: string;
      accessTokenExpiresAt: number;
    },
    private readonly write: (update: {
      accessToken: string;
      accessTokenExpiresAt: number;
    }) => Promise<void>,
  ) {}

  get isAuthenticated(): boolean {
    const { appKey, refreshToken } = this.read();
    return Boolean(appKey && refreshToken);
  }

  async getAccessToken(): Promise<string> {
    const { appKey, refreshToken, accessToken, accessTokenExpiresAt } = this.read();

    if (!appKey) throw new AuthError("No Dropbox app key configured.", true);
    if (!refreshToken) throw new AuthError("Not connected to Dropbox.", true);

    if (accessToken && Date.now() < accessTokenExpiresAt - EXPIRY_MARGIN_MS) {
      return accessToken;
    }

    // Several parallel API calls can discover expiry at the same moment; only
    // one of them should actually hit the token endpoint.
    if (!this.inFlight) {
      this.inFlight = this.refresh(appKey, refreshToken).finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  /** Force a refresh even if the cached token still looks valid. */
  async invalidate(): Promise<void> {
    await this.write({ accessToken: "", accessTokenExpiresAt: 0 });
  }

  private async refresh(appKey: string, refreshToken: string): Promise<string> {
    let token: TokenResponse;
    try {
      token = await postToken({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: appKey,
      });
    } catch (err) {
      if (err instanceof AuthError) throw err;
      throw new AuthError(`Could not refresh Dropbox token: ${errorMessage(err)}`);
    }

    await this.write({
      accessToken: token.access_token,
      accessTokenExpiresAt: Date.now() + token.expires_in * 1000,
    });
    return token.access_token;
  }
}

async function postToken(fields: Record<string, string>): Promise<TokenResponse> {
  const response = await requestUrl({
    url: TOKEN_URL,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
    throw: false,
  });

  if (response.status >= 400) {
    const detail = describeTokenError(response.text);
    // An invalid_grant means the refresh token is dead — revoked, or the app's
    // permissions changed. No amount of retrying fixes that.
    const dead = /invalid_grant|invalid_client/.test(response.text ?? "");
    throw new AuthError(`Dropbox auth failed (${response.status}): ${detail}`, dead);
  }

  const token = response.json as TokenResponse;
  if (!token?.access_token) {
    throw new AuthError("Dropbox returned no access token.");
  }
  return token;
}

function describeTokenError(text: string | undefined): string {
  if (!text) return "no response body";
  try {
    const parsed = JSON.parse(text) as {
      error?: string;
      error_description?: string;
    };
    return parsed.error_description ?? parsed.error ?? text;
  } catch {
    return text.slice(0, 200);
  }
}

/** A short, stable-ish default device name for conflict filenames. */
export function guessDeviceName(isMobile: boolean): string {
  return isMobile ? `mobile-${randomId(2)}` : `desktop-${randomId(2)}`;
}
