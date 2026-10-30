import React, { useState, useMemo } from "react";
import { SlidersHorizontal, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  can,
  hasModule,
  sessionScope,
  type Session,
} from "@/features/session/model";

export const OVERVIEW_FEATURE_NAMESPACE = "overview-widgets";
export const OVERVIEW_STORAGE_VERSION = 1;
export const OVERVIEW_STORAGE_KEY_PREFIX = `nexoisp:${OVERVIEW_FEATURE_NAMESPACE}:v${OVERVIEW_STORAGE_VERSION}:`;
export const MAX_PREFERENCES_STORAGE_BYTES = 8192; // 8 KiB

export const OVERVIEW_OPTIONAL_WIDGETS = [
  "revenue",
  "contract-trends",
  "agenda",
] as const;

export type OverviewOptionalWidgetId =
  (typeof OVERVIEW_OPTIONAL_WIDGETS)[number];

export const DEFAULT_OVERVIEW_WIDGETS: readonly OverviewOptionalWidgetId[] =
  OVERVIEW_OPTIONAL_WIDGETS;

export interface StoredOverviewPreferences {
  version: 1;
  widgets: OverviewOptionalWidgetId[];
}

export type StorageStatus = "persisted" | "in-memory";

export interface OverviewWidgetDefinition {
  id: OverviewOptionalWidgetId;
  label: string;
  description: string;
  permissionNote: string;
}

export const OVERVIEW_WIDGET_DEFINITIONS: Record<
  OverviewOptionalWidgetId,
  OverviewWidgetDefinition
> = {
  revenue: {
    id: "revenue",
    label: "Receita recebida",
    description: "Gráfico de faturamento e evolução mensal de pagamentos",
    permissionNote: "Requer permissão de financeiro (finance:read)",
  },
  "contract-trends": {
    id: "contract-trends",
    label: "Ativações e encerramentos",
    description: "Contratos ativados e encerrados nos últimos doze meses",
    permissionNote: "Requer permissão de rede (network:read)",
  },
  agenda: {
    id: "agenda",
    label: "Visitas de hoje",
    description: "Ordens de serviço agendadas para o dia e status dos técnicos",
    permissionNote:
      "Requer permissão de ordens de serviço (os:read) e módulo Campo",
  },
};

export function getUtf8ByteLength(str: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(str).byteLength;
  }
  let bytes = 0;
  for (let i = 0; i < str.length; i++) {
    const codePoint = str.codePointAt(i);
    if (codePoint === undefined) continue;
    if (codePoint <= 0x7f) {
      bytes += 1;
    } else if (codePoint <= 0x7ff) {
      bytes += 2;
    } else if (codePoint <= 0xffff) {
      bytes += 3;
    } else {
      bytes += 4;
      i++;
    }
  }
  return bytes;
}

export function isWidgetAuthorized(
  id: OverviewOptionalWidgetId,
  me: Session | null,
): boolean {
  if (!me) return false;
  switch (id) {
    case "revenue":
      return can(me, "finance:read");
    case "contract-trends":
      return can(me, "network:read");
    case "agenda":
      return can(me, "os:read") && hasModule(me, "field");
    default:
      return false;
  }
}

export function isTeamSession(me: Session | null): boolean {
  if (!me) return false;
  if (me.mfa_pending) return false;
  if (me.role === "subscriber") return false;
  if (!me.tenant) return false;
  return true;
}

export function getOverviewStorageKey(scope: string): string {
  return `${OVERVIEW_STORAGE_KEY_PREFIX}${scope}`;
}

export function getDefaultOverviewPreferences(): StoredOverviewPreferences {
  return {
    version: 1,
    widgets: [...DEFAULT_OVERVIEW_WIDGETS],
  };
}

export function parseOverviewPreferences(
  raw: string | null,
): StoredOverviewPreferences | null {
  if (raw === null || typeof raw !== "string") return null;

  // Limite estrito em bytes UTF-8 antes de qualquer parse
  if (getUtf8ByteLength(raw) > MAX_PREFERENCES_STORAGE_BYTES) return null;

  try {
    const data = JSON.parse(raw);
    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      data.version !== 1 ||
      !Array.isArray(data.widgets)
    ) {
      return null;
    }

    // Rejeição estrita de qualquer propriedade desconhecida
    const allowedKeys = new Set(["version", "widgets"]);
    const keys = Object.keys(data);
    if (keys.length !== 2 || !keys.every((k) => allowedKeys.has(k))) {
      return null;
    }

    const widgets: OverviewOptionalWidgetId[] = [];
    for (const item of data.widgets) {
      if (
        typeof item !== "string" ||
        !(OVERVIEW_OPTIONAL_WIDGETS as readonly string[]).includes(item) ||
        widgets.includes(item as OverviewOptionalWidgetId)
      ) {
        // Campo desconhecido, tipo inválido ou duplicata => default seguro
        return null;
      }
      widgets.push(item as OverviewOptionalWidgetId);
    }

    return {
      version: 1,
      widgets,
    };
  } catch {
    return null;
  }
}

export function getEffectiveVisibleWidgets(
  preferences: StoredOverviewPreferences,
  me: Session | null,
): Set<OverviewOptionalWidgetId> {
  const visible = new Set<OverviewOptionalWidgetId>();
  for (const id of preferences.widgets) {
    if (isWidgetAuthorized(id, me)) {
      visible.add(id);
    }
  }
  return visible;
}

function resolveStorage(storage?: Storage | null): Storage | null {
  if (storage !== undefined) return storage;
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    return null;
  }
  return null;
}

export function readPreferences(
  scope: string | null,
  storage?: Storage | null,
): {
  preferences: StoredOverviewPreferences;
  isCustomized: boolean;
  storageAvailable: boolean;
} {
  if (!scope) {
    return {
      preferences: getDefaultOverviewPreferences(),
      isCustomized: false,
      storageAvailable: true,
    };
  }

  const s = resolveStorage(storage);
  if (!s) {
    return {
      preferences: getDefaultOverviewPreferences(),
      isCustomized: false,
      storageAvailable: false,
    };
  }

  try {
    const key = getOverviewStorageKey(scope);
    const raw = s.getItem(key);
    if (raw === null) {
      return {
        preferences: getDefaultOverviewPreferences(),
        isCustomized: false,
        storageAvailable: true,
      };
    }

    const parsed = parseOverviewPreferences(raw);
    if (!parsed) {
      return {
        preferences: getDefaultOverviewPreferences(),
        isCustomized: false,
        storageAvailable: true,
      };
    }

    return {
      preferences: parsed,
      isCustomized: true,
      storageAvailable: true,
    };
  } catch {
    return {
      preferences: getDefaultOverviewPreferences(),
      isCustomized: false,
      storageAvailable: false,
    };
  }
}

export function savePreferences(
  scope: string,
  preferences: StoredOverviewPreferences,
  storage?: Storage | null,
): { success: boolean; storageAvailable: boolean; error?: unknown } {
  const s = resolveStorage(storage);
  if (!s) {
    return { success: false, storageAvailable: false };
  }

  try {
    const key = getOverviewStorageKey(scope);
    const validWidgets = preferences.widgets.filter((w) =>
      OVERVIEW_OPTIONAL_WIDGETS.includes(w),
    );
    const dedupedWidgets = Array.from(new Set(validWidgets));
    const payload = JSON.stringify({
      version: 1,
      widgets: dedupedWidgets,
    });
    if (getUtf8ByteLength(payload) > MAX_PREFERENCES_STORAGE_BYTES) {
      return { success: false, storageAvailable: true };
    }
    s.setItem(key, payload);
    return { success: true, storageAvailable: true };
  } catch (error) {
    return { success: false, storageAvailable: false, error };
  }
}

export function resetPreferences(
  scope: string,
  storage?: Storage | null,
): { success: boolean; storageAvailable: boolean; error?: unknown } {
  const s = resolveStorage(storage);
  if (!s) {
    return { success: false, storageAvailable: false };
  }

  try {
    const key = getOverviewStorageKey(scope);
    s.removeItem(key);
    return { success: true, storageAvailable: true };
  } catch (error) {
    return { success: false, storageAvailable: false, error };
  }
}

export function useOverviewPreferences(
  me: Session | null,
  storage?: Storage | null,
) {
  const isTeam = isTeamSession(me);
  const scope = isTeam && me ? sessionScope(me) : null;

  const [state, setState] = useState(() => {
    const initial = readPreferences(scope, storage);
    return {
      scope,
      preferences: initial.preferences,
      isCustomized: initial.isCustomized,
      storageStatus: (initial.storageAvailable
        ? "persisted"
        : "in-memory") as StorageStatus,
    };
  });

  let currentPreferences = state.preferences;
  let currentCustomized = state.isCustomized;
  let currentStorageStatus = state.storageStatus;

  // Transição sincronizada sem render stale:
  // Mudança de escopo (logout, troca de usuário, saída de suporte, tenant ou permissões)
  // atualiza as preferências sincronamente, sem exibir o escopo anterior nem por um único render.
  if (state.scope !== scope) {
    const fresh = readPreferences(scope, storage);
    currentPreferences = fresh.preferences;
    currentCustomized = fresh.isCustomized;
    currentStorageStatus = fresh.storageAvailable ? "persisted" : "in-memory";
    setState({
      scope,
      preferences: currentPreferences,
      isCustomized: currentCustomized,
      storageStatus: currentStorageStatus,
    });
  }

  const toggleWidget = (
    widgetId: OverviewOptionalWidgetId,
    enabled: boolean,
  ) => {
    const newWidgets = enabled
      ? Array.from(new Set([...currentPreferences.widgets, widgetId]))
      : currentPreferences.widgets.filter((id) => id !== widgetId);

    const nextPreferences: StoredOverviewPreferences = {
      version: 1,
      widgets: newWidgets,
    };

    let nextStatus = currentStorageStatus;
    if (scope) {
      const res = savePreferences(scope, nextPreferences, storage);
      nextStatus = res.success ? "persisted" : "in-memory";
    }

    setState({
      scope,
      preferences: nextPreferences,
      isCustomized: true,
      storageStatus: nextStatus,
    });
  };

  const handleReset = () => {
    const defaultPrefs = getDefaultOverviewPreferences();
    let nextStatus = currentStorageStatus;
    if (scope) {
      const res = resetPreferences(scope, storage);
      nextStatus = res.success ? "persisted" : "in-memory";
    }

    setState({
      scope,
      preferences: defaultPrefs,
      isCustomized: false,
      storageStatus: nextStatus,
    });
  };

  const visibleWidgets = useMemo(
    () => getEffectiveVisibleWidgets(currentPreferences, me),
    [currentPreferences, me],
  );

  const isWidgetVisible = (widgetId: OverviewOptionalWidgetId): boolean => {
    return visibleWidgets.has(widgetId);
  };

  return {
    isTeam,
    scope,
    preferences: currentPreferences,
    isCustomized: currentCustomized,
    storageStatus: currentStorageStatus,
    visibleWidgets,
    isWidgetVisible,
    toggleWidget,
    resetPreferences: handleReset,
  };
}

export function OverviewPreferencesForm({
  me,
  preferences,
  storageStatus,
  onToggleWidget,
  onReset,
  onClose,
}: {
  me: Session | null;
  preferences: StoredOverviewPreferences;
  storageStatus: StorageStatus;
  onToggleWidget: (id: OverviewOptionalWidgetId, enabled: boolean) => void;
  onReset: () => void;
  onClose?: () => void;
}) {
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      DialogHeader,
      null,
      React.createElement(DialogTitle, null, "Personalizar painel"),
      React.createElement(
        DialogDescription,
        null,
        "Selecione os blocos opcionais exibidos na Visão geral. As preferências são aplicadas apenas neste navegador.",
      ),
    ),
    React.createElement(
      "div",
      {
        className: "flex flex-col gap-3 py-2",
        role: "group",
        "aria-label": "Blocos opcionais da visão geral",
      },
      OVERVIEW_OPTIONAL_WIDGETS.map((id) => {
        const def = OVERVIEW_WIDGET_DEFINITIONS[id];
        const authorized = isWidgetAuthorized(id, me);
        const isChecked = authorized && preferences.widgets.includes(id);

        return React.createElement(
          "div",
          {
            key: id,
            className:
              "flex items-start gap-3 rounded-lg border p-3 text-sm hover:bg-muted/50",
          },
          React.createElement("input", {
            type: "checkbox",
            id: `overview-pref-${id}`,
            checked: isChecked,
            disabled: !authorized,
            onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
              onToggleWidget(id, e.target.checked),
            className: "mt-1",
            "aria-describedby": `overview-pref-desc-${id}`,
          }),
          React.createElement(
            "label",
            {
              htmlFor: `overview-pref-${id}`,
              className: "flex flex-col gap-0.5 cursor-pointer select-none",
            },
            React.createElement(
              "span",
              { className: "font-medium text-foreground" },
              def.label,
            ),
            React.createElement(
              "span",
              {
                id: `overview-pref-desc-${id}`,
                className: "text-xs text-muted-foreground",
              },
              def.description,
            ),
            !authorized &&
              React.createElement(
                "span",
                {
                  className: "text-xs text-amber-600 dark:text-amber-500",
                },
                def.permissionNote,
              ),
          ),
        );
      }),
    ),
    React.createElement(
      "div",
      {
        className: "text-xs text-muted-foreground pt-1 border-t space-y-1",
      },
      React.createElement(
        "p",
        null,
        "Válido apenas neste navegador. Indicadores, prioridades e alertas continuam sempre ativos.",
      ),
      storageStatus === "in-memory" &&
        React.createElement(
          "p",
          {
            role: "status",
            className: "text-amber-600 dark:text-amber-500 font-medium",
          },
          "Armazenamento local indisponível; preferências mantidas apenas em memória nesta sessão.",
        ),
    ),
    React.createElement(
      DialogFooter,
      {
        className: "flex items-center justify-between gap-2 sm:justify-between",
      },
      React.createElement(
        Button,
        {
          variant: "ghost",
          size: "sm",
          onClick: () => {
            onReset();
          },
        },
        React.createElement(RotateCcw, {
          "data-icon": "inline-start",
        } as React.ComponentProps<typeof RotateCcw>),
        "Restaurar padrão",
      ),
      onClose &&
        React.createElement(
          Button,
          {
            variant: "outline",
            size: "sm",
            onClick: onClose,
          },
          "Fechar",
        ),
    ),
  );
}

export function OverviewPreferencesControl({
  me,
  preferences,
  storageStatus,
  onToggleWidget,
  onReset,
}: {
  me: Session | null;
  preferences: StoredOverviewPreferences;
  storageStatus: StorageStatus;
  onToggleWidget: (id: OverviewOptionalWidgetId, enabled: boolean) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);

  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      Button,
      {
        variant: "outline",
        size: "sm",
        onClick: () => setOpen(true),
        "aria-label": "Personalizar painel da visão geral",
      },
      React.createElement(SlidersHorizontal, {
        "data-icon": "inline-start",
      } as React.ComponentProps<typeof SlidersHorizontal>),
      "Personalizar painel",
    ),
    React.createElement(
      Dialog,
      { open, onOpenChange: setOpen },
      React.createElement(
        DialogContent,
        { className: "erp-editor sm:max-w-md" },
        React.createElement(OverviewPreferencesForm, {
          me,
          preferences,
          storageStatus,
          onToggleWidget,
          onReset,
          onClose: () => setOpen(false),
        }),
      ),
    ),
  );
}
