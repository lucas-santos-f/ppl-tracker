// Sync through the GitHub Contents API. No server: every device runs its own
// copy of the app and only the data file travels, straight from the browser to
// a PRIVATE repo, with a fine-grained token scoped to that one repo. The token
// stays in this device's localStorage and is never part of a backup.

const API = 'https://api.github.com';

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

// btoa/atob only speak Latin1 and the history is full of accents
function toBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}
function fromBase64(str) {
  return decodeURIComponent(escape(atob(str)));
}

class SyncError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const fileUrl = (repo, path) => `${API}/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;

/** Check the token can see the repo and that the repo is private. */
export async function syncVerify({ repo, token }) {
  if (!repo || !repo.includes('/')) throw new SyncError('Repo has to look like "owner/repo-name".', 'bad_repo');
  if (!token) throw new SyncError('Paste the GitHub token.', 'no_token');

  let res;
  try {
    res = await fetch(`${API}/repos/${repo}`, { headers: headers(token), cache: 'no-store' });
  } catch {
    throw new SyncError("Can't reach GitHub right now.", 'network');
  }

  if (res.status === 401) throw new SyncError('Token is invalid, expired or has no access to this repo.', 'auth');
  if (res.status === 404) throw new SyncError("Repo not found (or the token can't see it).", 'not_found');
  if (!res.ok) throw new SyncError(`GitHub respondeu ${res.status}.`, 'http');

  const data = await res.json();
  if (data.private === false) {
    throw new SyncError('This repo is PUBLIC. Use a private one: create a new repo or make this one private first.', 'public_repo');
  }
  return { ok: true, fullName: data.full_name };
}

/**
 * Download the data file. Pass the last etag and GitHub answers 304 with no
 * body, which doesn't count against the rate limit, so polling every minute is fine.
 */
export async function syncPull({ repo, path, token, etag }) {
  const h = headers(token);
  if (etag) h['If-None-Match'] = etag;
  let res;
  try {
    res = await fetch(fileUrl(repo, path), { headers: h, cache: 'no-store' });
  } catch {
    throw new SyncError("Can't reach GitHub right now.", 'network');
  }

  if (res.status === 304) return { notModified: true };
  if (res.status === 404) return { data: null, sha: null, etag: null };
  if (res.status === 401) throw new SyncError('Token is invalid or expired.', 'auth');
  if (!res.ok) throw new SyncError(`Falha ao baixar (${res.status}).`, 'http');

  const json = await res.json();
  try {
    let text;
    if (json.encoding === 'base64' && json.content) {
      text = fromBase64(json.content.replace(/\n/g, ''));
    } else {
      // over 1MB the contents endpoint stops inlining the file, ask for raw
      const raw = await fetch(fileUrl(repo, path), {
        headers: { ...headers(token), Accept: 'application/vnd.github.raw+json' }, cache: 'no-store',
      });
      text = await raw.text();
    }
    return { data: JSON.parse(text), sha: json.sha, etag: res.headers.get('ETag') };
  } catch {
    throw new SyncError('The file on GitHub is not valid JSON.', 'bad_data');
  }
}

/**
 * Upload, overwriting the remote file. `sha` is the version this device read
 * last; if the other phone pushed in between, GitHub rejects it (409) instead
 * of silently eating their change, and the caller pulls, merges and retries.
 * keepalive lets the request finish when iOS backgrounds the app (64KB cap,
 * so it's only used for the draft).
 */
export async function syncPush({ repo, path, token, data, sha, keepalive = false }) {
  const body = {
    message: `sync ${new Date().toISOString()}`,
    content: toBase64(JSON.stringify(data)),
  };
  if (sha) body.sha = sha;

  let res;
  try {
    res = await fetch(fileUrl(repo, path), {
      method: 'PUT',
      headers: { ...headers(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      keepalive,
    });
  } catch {
    throw new SyncError("Can't reach GitHub right now.", 'network');
  }

  // 422 = the file got created by the other device and we sent no sha
  if (res.status === 409 || res.status === 422) {
    throw new SyncError('The file on GitHub changed in the meantime.', 'conflict');
  }
  if (res.status === 401) throw new SyncError('Token is invalid or expired.', 'auth');
  if (res.status === 403) throw new SyncError('The token has no write access, or GitHub is rate limiting for now.', 'forbidden');
  if (!res.ok) throw new SyncError(`Falha ao enviar (${res.status}).`, 'http');

  const json = await res.json();
  return { sha: json.content.sha };
}

export { SyncError };
