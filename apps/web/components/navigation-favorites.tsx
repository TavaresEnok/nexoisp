"use client";

import React, { useCallback, useMemo, useState } from "react";
import { Star } from "lucide-react";
import Link from "@/platform/navigation/link";
import { cn } from "@/lib/utils";
import type { ShellAdapter } from "@/components/shell-context";
import {
  isValidFavoriteCandidate,
  readStoredFavorites,
  resolveValidFavorites,
  writeStoredFavorites,
  MAX_FAVORITES,
  type FavoritePage,
} from "@/lib/navigation-favorites";

export function useNavigationFavorites(
  shell?: ShellAdapter | null,
  storageOverride?: Storage | null,
) {
  const preferenceScope = shell?.preferenceScope ?? null;

  const [state, setState] = useState(() => {
    if (!preferenceScope) {
      return { scope: null, items: [] as string[], isPersisted: false };
    }
    const read = readStoredFavorites(preferenceScope, storageOverride, shell);
    return {
      scope: preferenceScope,
      items: read.items,
      isPersisted: read.isPersisted,
    };
  });

  // Troca de escopo síncrona: garante que dados de outra identidade nunca apareçam,
  // nem por um único render.
  let effectiveState = state;
  if (state.scope !== preferenceScope) {
    if (!preferenceScope) {
      effectiveState = { scope: null, items: [], isPersisted: false };
    } else {
      const read = readStoredFavorites(preferenceScope, storageOverride, shell);
      effectiveState = {
        scope: preferenceScope,
        items: read.items,
        isPersisted: read.isPersisted,
      };
    }
    setState(effectiveState);
  }

  const isEligible = Boolean(preferenceScope);

  const resolvedFavorites = useMemo(() => {
    if (!isEligible) return [];
    return resolveValidFavorites(effectiveState.items, shell);
  }, [isEligible, effectiveState.items, shell]);

  const isFavorite = useCallback(
    (path: string) => {
      if (!isEligible) return false;
      if (!isValidFavoriteCandidate(path, shell)) return false;
      return effectiveState.items.includes(path);
    },
    [isEligible, effectiveState.items, shell],
  );

  const toggleFavorite = useCallback(
    (path: string) => {
      if (!preferenceScope) return;

      const sanitizedCurrent = effectiveState.items.filter(
        (item) =>
          typeof item === "string" && isValidFavoriteCandidate(item, shell),
      );

      const currentlyFavorite = sanitizedCurrent.includes(path);
      let nextItems: string[];

      if (currentlyFavorite) {
        nextItems = sanitizedCurrent.filter((item) => item !== path);
      } else {
        if (!isValidFavoriteCandidate(path, shell)) {
          return;
        }
        nextItems = [...sanitizedCurrent, path].slice(0, MAX_FAVORITES);
      }

      const persisted = writeStoredFavorites(
        preferenceScope,
        nextItems,
        storageOverride,
        shell,
      );

      setState({
        scope: preferenceScope,
        items: nextItems,
        isPersisted: persisted,
      });
    },
    [preferenceScope, effectiveState.items, shell, storageOverride],
  );

  return {
    isEligible,
    favorites: resolvedFavorites,
    isFavorite,
    toggleFavorite,
    isPersisted: effectiveState.isPersisted,
  };
}

export function FavoriteToggleButton({
  href,
  label,
  isFavorite,
  onToggle,
}: {
  href: string;
  label: string;
  isFavorite: boolean;
  onToggle: (href: string) => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "branch-toggle favorite-toggle",
        isFavorite && "is-favorite",
      )}
      aria-pressed={isFavorite}
      aria-label={
        isFavorite
          ? `Remover ${label} dos favoritos`
          : `Adicionar ${label} aos favoritos`
      }
      title={
        isFavorite
          ? `Remover ${label} dos favoritos`
          : `Adicionar ${label} aos favoritos`
      }
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onToggle(href);
      }}
    >
      <Star
        size={13}
        className={cn(
          isFavorite
            ? "fill-amber-500 text-amber-500"
            : "text-muted-foreground opacity-60 hover:opacity-100",
        )}
      />
    </button>
  );
}

export function NavigationFavoritesSection({
  favorites,
  pathname,
  collapsed,
  isPersisted,
  onNavigate,
  onToggle,
}: {
  favorites: FavoritePage[];
  pathname: string;
  collapsed: boolean;
  isPersisted: boolean;
  onNavigate: () => void;
  onToggle: (href: string) => void;
}) {
  if (collapsed && favorites.length === 0) {
    return null;
  }

  const persistenceNotice = isPersisted
    ? "Preferência local salva neste navegador"
    : "Armazenamento local indisponível; ativo temporariamente em memória";

  return (
    <div
      className="sidebar-favorites"
      aria-label="Favoritos de navegação neste navegador"
    >
      <div className="flex items-center justify-between px-2.5 mt-4 mb-2">
        <p className="context-label m-0 p-0">FAVORITOS</p>
        <span
          className="text-[10px] text-muted-foreground uppercase tracking-wider"
          title={persistenceNotice}
        >
          {isPersisted ? "Neste navegador" : "Em memória"}
        </span>
      </div>

      {favorites.length === 0 ? (
        <p className="text-[11px] text-muted-foreground px-2.5 py-1">
          Nenhum favorito selecionado
        </p>
      ) : (
        <ul className="sidebar-favorites-links flex flex-col gap-0.5 list-none m-0 p-0">
          {favorites.map((fav) => {
            const isActive = pathname === fav.href;
            return (
              <li key={fav.href}>
                <div className="navigation-branch-row">
                  <Link
                    href={fav.href}
                    prefetch={false}
                    className={cn("context-link", isActive && "active")}
                    onClick={onNavigate}
                    aria-label={collapsed ? fav.label : undefined}
                    aria-current={isActive ? "page" : undefined}
                    title={`${fav.label} · Favorito neste navegador`}
                  >
                    <Star
                      size={16}
                      className="text-amber-500 fill-amber-500 shrink-0"
                    />
                    <span>{fav.label}</span>
                  </Link>
                  {!collapsed && (
                    <button
                      type="button"
                      className="branch-toggle favorite-toggle is-favorite"
                      aria-pressed="true"
                      aria-label={`Remover ${fav.label} dos favoritos`}
                      title={`Remover ${fav.label} dos favoritos`}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onToggle(fav.href);
                      }}
                    >
                      <Star
                        size={13}
                        className="fill-amber-500 text-amber-500"
                      />
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
