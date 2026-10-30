import type { ShellAdapter } from "@/components/shell-context";
import { findNavigationPage, type NavigationNode } from "@/lib/navigation";
import {
  operationalNavigationAreas,
  plannedPaths,
  resolveCatalogueNode,
} from "@/features/operations/catalogue";
import { integrationStatus } from "@/features/operations/status";

export const MAX_FAVORITES = 12;
export const MAX_STORAGE_BYTES = 8192; // 8 KiB
export const FAVORITES_STORAGE_PREFIX = "nexo:v1:favorites:";

export type FavoritesStoragePayload = {
  version: 1;
  items: string[];
};

export type FavoritePage = {
  href: string;
  label: string;
};

const UUID_REGEX =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const NUMERIC_ID_REGEX = /^\d+$/;

function hasRecordId(path: string): boolean {
  const segments = path.split("/").filter(Boolean);
  return segments.some(
    (seg) =>
      UUID_REGEX.test(seg) || (NUMERIC_ID_REGEX.test(seg) && seg.length >= 3),
  );
}

function isDisallowedRoute(path: string): boolean {
  if (/^(?:https?:|\/\/|javascript:)/i.test(path)) return true;
  if (path === "/login" || path.startsWith("/login/")) return true;
  if (path === "/sair" || path.startsWith("/sair/") || path === "/logout")
    return true;
  if (path === "/portal" || path.startsWith("/portal/")) return true;
  if (path === "/provedores" || path.startsWith("/provedores/")) return true;
  if (path === "/aviso-bloqueio" || path.startsWith("/aviso-bloqueio/"))
    return true;
  if (path === "/conta" || path.startsWith("/conta/")) return true;
  return false;
}

/**
 * Monta o catálogo operacional estático de páginas de equipe.
 * Deriva os rótulos e páginas estáticas conhecidas e conectadas ao ERP.
 */
export function getTeamCataloguePages(
  shell?: ShellAdapter | null,
): Map<string, { href: string; label: string }> {
  const map = new Map<string, { href: string; label: string }>();

  // Raiz do painel operacional
  const rootNode = findNavigationPage("/");
  if (
    rootNode &&
    !plannedPaths.has("/") &&
    integrationStatus("/") === "connected"
  ) {
    map.set("/", { href: "/", label: rootNode.label || "Painel inicial" });
  }

  // Gestão do workspace (páginas estáticas de equipe)
  if (
    !plannedPaths.has("/configuracoes") &&
    integrationStatus("/configuracoes") === "connected"
  ) {
    map.set("/configuracoes", {
      href: "/configuracoes",
      label: "Configurações",
    });
  }
  if (
    !plannedPaths.has("/estrutura") &&
    integrationStatus("/estrutura") === "connected"
  ) {
    map.set("/estrutura", { href: "/estrutura", label: "Mapa de páginas" });
  }

  // Áreas operacionais de equipe
  const areas = shell ? shell.areas() : operationalNavigationAreas();
  function collect(node: NavigationNode) {
    if (
      node.audience === "Equipe" &&
      node.href &&
      node.href.startsWith("/") &&
      !node.href.startsWith("//") &&
      !node.href.includes("?") &&
      !node.href.includes("#") &&
      !hasRecordId(node.href) &&
      !isDisallowedRoute(node.href) &&
      !plannedPaths.has(node.href)
    ) {
      const resolution = resolveCatalogueNode(node.href);
      const isSubaction = resolution?.kind === "subaction";
      const isPlanned = resolution?.kind === "planned";
      const hasQueryDest = Boolean(
        resolution &&
          resolution.kind !== "planned" &&
          (resolution.destination.includes("?") ||
            resolution.destination.includes("#")),
      );

      if (!isSubaction && !isPlanned && !hasQueryDest) {
        const isConnected = shell
          ? shell.connected(node.href)
          : integrationStatus(node.href) === "connected";
        if (isConnected) {
          map.set(node.href, { href: node.href, label: node.label });
        }
      }
    }

    if (node.children && node.children.length > 0) {
      for (const child of node.children) {
        collect(child);
      }
    }
  }

  for (const area of areas) {
    if (area.id === "saas" || area.id === "portal" || area.id === "acesso") {
      continue;
    }
    for (const page of area.pages) {
      collect(page);
    }
  }

  return map;
}

/**
 * Valida se um caminho é um candidato legítimo a favorito de equipe.
 * Invalida URLs externas, //, javascript:, query/hash, IDs de registro,
 * páginas planejadas, rotas de saída/login/portal/operador e caminhos desconhecidos.
 * Não aceita caminhos que apenas satisfazem prefixo.
 */
export function isValidFavoriteCandidate(
  path: string,
  shell?: ShellAdapter | null,
): boolean {
  if (!path || typeof path !== "string") return false;
  if (!path.startsWith("/") || path.startsWith("//")) return false;
  if (path.includes("?") || path.includes("#")) return false;
  if (hasRecordId(path)) return false;
  if (isDisallowedRoute(path)) return false;
  if (plannedPaths.has(path)) return false;

  const resolution = resolveCatalogueNode(path);
  if (resolution) {
    if (resolution.kind === "planned" || resolution.kind === "subaction") {
      return false;
    }
    if (
      resolution.destination.includes("?") ||
      resolution.destination.includes("#")
    ) {
      return false;
    }
  }

  const catalogue = getTeamCataloguePages(shell);
  if (!catalogue.has(path)) {
    return false;
  }

  if (shell) {
    if (!shell.connected(path) || !shell.canAccess(path)) {
      return false;
    }
  }

  return true;
}

/**
 * Namespace versionado e isolado por escopo de sessão:
 * user+tenant+role+support+perms+modules
 */
export function getFavoritesStorageKey(preferenceScope: string): string {
  return `${FAVORITES_STORAGE_PREFIX}${preferenceScope}`;
}

export type ReadFavoritesResult = {
  items: string[];
  isPersisted: boolean;
};

function resolveTargetStorage(
  storageOverride?: Storage | null,
): Storage | null {
  if (storageOverride !== undefined) {
    return storageOverride;
  }
  try {
    if (typeof window !== "undefined") {
      return window.localStorage;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Lê os favoritos do armazenamento local com fail-safe completo:
 * - Validação de tamanho (máximo 8 KiB antes do parse)
 * - Validação estrita de formato (sem campos desconhecidos)
 * - Versão exata 1 (sem migrações automáticas)
 * - Isolamento por escopo
 * - Operação em memória se o armazenamento falhar
 * - Sanitização contra catálogo estático e autorização corrente antes do limite
 */
export function readStoredFavorites(
  preferenceScope: string | null | undefined,
  storage?: Storage | null,
  shell?: ShellAdapter | null,
): ReadFavoritesResult {
  if (!preferenceScope) {
    return { items: [], isPersisted: false };
  }

  try {
    const targetStorage = resolveTargetStorage(storage);
    if (!targetStorage) {
      return { items: [], isPersisted: false };
    }

    const key = getFavoritesStorageKey(preferenceScope);
    const raw = targetStorage.getItem(key);
    if (raw === null) {
      return { items: [], isPersisted: true };
    }

    if (raw.length > MAX_STORAGE_BYTES) {
      return { items: [], isPersisted: true };
    }

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { items: [], isPersisted: true };
    }

    const keys = Object.keys(parsed);
    if (keys.some((k) => k !== "version" && k !== "items")) {
      return { items: [], isPersisted: true };
    }

    if (parsed.version !== 1 || !Array.isArray(parsed.items)) {
      return { items: [], isPersisted: true };
    }

    const deduped: string[] = [];
    for (const item of parsed.items) {
      if (
        typeof item === "string" &&
        isValidFavoriteCandidate(item, shell) &&
        !deduped.includes(item)
      ) {
        deduped.push(item);
      }
      if (deduped.length >= MAX_FAVORITES) break;
    }

    return { items: deduped, isPersisted: true };
  } catch {
    return { items: [], isPersisted: false };
  }
}

/**
 * Salva os favoritos no armazenamento local.
 * Retorna true se a persistência ocorreu com sucesso, ou false se falhou.
 * Sanitiza candidatos válidos por catálogo e permissão antes de persistir.
 */
export function writeStoredFavorites(
  preferenceScope: string | null | undefined,
  items: string[],
  storage?: Storage | null,
  shell?: ShellAdapter | null,
): boolean {
  if (!preferenceScope) {
    return false;
  }

  try {
    const targetStorage = resolveTargetStorage(storage);
    if (!targetStorage) {
      return false;
    }

    const key = getFavoritesStorageKey(preferenceScope);
    const validItems: string[] = [];
    for (const item of items) {
      if (
        typeof item === "string" &&
        isValidFavoriteCandidate(item, shell) &&
        !validItems.includes(item)
      ) {
        validItems.push(item);
      }
      if (validItems.length >= MAX_FAVORITES) break;
    }

    const payload: FavoritesStoragePayload = {
      version: 1,
      items: validItems,
    };

    const serialized = JSON.stringify(payload);
    if (serialized.length > MAX_STORAGE_BYTES) {
      return false;
    }

    targetStorage.setItem(key, serialized);
    return true;
  } catch {
    return false;
  }
}

/**
 * Deriva os favoritos a cada render a partir do catálogo operacional.
 * - Limite de 12 itens
 * - Dedup e preservação da ordem de inserção
 * - Rótulos e destinos derivados dinamicamente
 * - Se permissões ou módulos mudarem, filtra antes de renderizar
 */
export function resolveValidFavorites(
  storedItems: string[],
  shell?: ShellAdapter | null,
): FavoritePage[] {
  const catalogue = getTeamCataloguePages(shell);
  const resolved: FavoritePage[] = [];
  const seen = new Set<string>();

  for (const path of storedItems) {
    if (seen.has(path)) continue;
    seen.add(path);

    if (isValidFavoriteCandidate(path, shell)) {
      const entry = catalogue.get(path);
      if (entry) {
        resolved.push({
          href: path,
          label: shell?.title(path) ?? entry.label,
        });
      }
    }

    if (resolved.length >= MAX_FAVORITES) break;
  }

  return resolved;
}
