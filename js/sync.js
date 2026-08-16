// Sincronização via GitHub Contents API.
//
// Não precisa de GitHub Pages, servidor, nem hospedar nada: cada aparelho já
// roda sua própria cópia do app (arquivo local ou dev server). Só os DADOS
// viajam, direto do navegador para a API do GitHub, usando um token com
// permissão restrita a um único repositório privado.
//
// O token nunca sai do aparelho onde foi digitado — fica só no localStorage
// daquele device, nunca é incluído no backup exportado nem em nenhum outro
// lugar.
//
// Não funciona dentro do Artifact publicado: a Content-Security-Policy do
// sandbox bloqueia toda chamada de rede para fora do domínio da própria
// página. Sync só roda no arquivo local (file://) ou num servidor próprio.

const API = 'https://api.github.com';

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

// UTF-8 seguro: btoa/atob só entendem Latin1, e o histórico tem acentos.
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

/**
 * Confirma que o token enxerga o repositório e que ele é privado.
 * Chamar antes do primeiro sync para dar erro claro cedo.
 */
export async function syncVerify({ repo, token }) {
  if (!repo || !repo.includes('/')) throw new SyncError('Repositório deve ser "usuario/nome-do-repo".', 'bad_repo');
  if (!token) throw new SyncError('Cole o token do GitHub.', 'no_token');

  let res;
  try {
    res = await fetch(`${API}/repos/${repo}`, { headers: headers(token) });
  } catch {
    throw new SyncError('Sem conexão com o GitHub agora.', 'network');
  }

  if (res.status === 401) throw new SyncError('Token inválido, expirado ou sem acesso a este repositório.', 'auth');
  if (res.status === 404) throw new SyncError('Repositório não encontrado (ou o token não alcança ele).', 'not_found');
  if (!res.ok) throw new SyncError(`GitHub respondeu ${res.status}.`, 'http');

  const data = await res.json();
  if (data.private === false) {
    throw new SyncError('Este repositório é PÚBLICO. Use um repositório privado — crie um novo ou torne este privado antes de continuar.', 'public_repo');
  }
  return { ok: true, fullName: data.full_name };
}

/**
 * Baixa o arquivo de dados do repositório.
 * @returns {{data: object|null, sha: string|null}} data é null se o arquivo
 *   ainda não existe (primeiro sync, ninguém subiu nada ainda).
 */
export async function syncPull({ repo, path, token }) {
  let res;
  try {
    res = await fetch(`${API}/repos/${repo}/contents/${encodeURIComponent(path)}`, { headers: headers(token) });
  } catch {
    throw new SyncError('Sem conexão com o GitHub agora.', 'network');
  }

  if (res.status === 404) return { data: null, sha: null };
  if (res.status === 401) throw new SyncError('Token inválido ou expirado.', 'auth');
  if (!res.ok) throw new SyncError(`Falha ao baixar (${res.status}).`, 'http');

  const json = await res.json();
  try {
    return { data: JSON.parse(fromBase64(json.content)), sha: json.sha };
  } catch {
    throw new SyncError('O arquivo no GitHub não é um JSON válido.', 'bad_data');
  }
}

/**
 * Sobe os dados, sobrescrevendo o remoto.
 *
 * `sha` é o identificador da versão remota que este aparelho leu por último.
 * Se alguém (ou outro aparelho) mudou o arquivo desde então, o GitHub recusa
 * com 409 em vez de perder a mudança do outro silenciosamente — a saída é
 * puxar (`pull`) de novo antes de subir.
 */
export async function syncPush({ repo, path, token, data, sha }) {
  const body = {
    message: `sync ${new Date().toISOString()}`,
    content: toBase64(JSON.stringify(data, null, 2)),
  };
  if (sha) body.sha = sha;

  let res;
  try {
    res = await fetch(`${API}/repos/${repo}/contents/${encodeURIComponent(path)}`, {
      method: 'PUT',
      headers: { ...headers(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new SyncError('Sem conexão com o GitHub agora.', 'network');
  }

  if (res.status === 409) {
    throw new SyncError('O arquivo no GitHub mudou desde a última vez que este aparelho o leu. Baixe antes de enviar de novo.', 'conflict');
  }
  if (res.status === 401) throw new SyncError('Token inválido ou expirado.', 'auth');
  if (!res.ok) throw new SyncError(`Falha ao enviar (${res.status}).`, 'http');

  const json = await res.json();
  return { sha: json.content.sha };
}

export { SyncError };
