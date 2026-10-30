import { useState, useMemo } from "react";
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
import { sessionScope, type Session } from "@/features/session/model";
import {
  OVERVIEW_OPTIONAL_WIDGETS,
  OVERVIEW_WIDGET_DEFINITIONS,
  getDefaultOverviewPreferences,
  getEffectiveVisibleWidgets,
  isTeamSession,
  isWidgetAuthorized,
  readPreferences,
  resetPreferences as resetStoragePreferences,
  savePreferences,
  type OverviewOptionalWidgetId,
  type StoredOverviewPreferences,
  type StorageStatus,
} from "./overview-preferences";

export type { StorageStatus };

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

  // Garantia obrigatória de transição imediata: mudança de escopo (logout, troca de usuário,
  // saída de suporte, tenant ou permissões) atualiza as preferências sincronamente, sem exibir
  // o escopo anterior nem por um único render.
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
      const res = resetStoragePreferences(scope, storage);
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
  return (
    <>
      <DialogHeader>
        <DialogTitle>Personalizar painel</DialogTitle>
        <DialogDescription>
          Selecione os blocos opcionais exibidos na Visão geral. As preferências
          são aplicadas apenas neste navegador.
        </DialogDescription>
      </DialogHeader>

      <div
        className="flex flex-col gap-3 py-2"
        role="group"
        aria-label="Blocos opcionais da visão geral"
      >
        {OVERVIEW_OPTIONAL_WIDGETS.map((id) => {
          const def = OVERVIEW_WIDGET_DEFINITIONS[id];
          const authorized = isWidgetAuthorized(id, me);
          const isChecked = authorized && preferences.widgets.includes(id);

          return (
            <div
              key={id}
              className="flex items-start gap-3 rounded-lg border p-3 text-sm hover:bg-muted/50"
            >
              <input
                type="checkbox"
                id={`overview-pref-${id}`}
                checked={isChecked}
                disabled={!authorized}
                onChange={(e) => onToggleWidget(id, e.target.checked)}
                className="mt-1"
                aria-describedby={`overview-pref-desc-${id}`}
              />
              <label
                htmlFor={`overview-pref-${id}`}
                className="flex flex-col gap-0.5 cursor-pointer select-none"
              >
                <span className="font-medium text-foreground">{def.label}</span>
                <span
                  id={`overview-pref-desc-${id}`}
                  className="text-xs text-muted-foreground"
                >
                  {def.description}
                </span>
                {!authorized && (
                  <span className="text-xs text-amber-600 dark:text-amber-500">
                    {def.permissionNote}
                  </span>
                )}
              </label>
            </div>
          );
        })}
      </div>

      <div className="text-xs text-muted-foreground pt-1 border-t space-y-1">
        <p>
          Válido apenas neste navegador. Indicadores, prioridades e alertas
          continuam sempre ativos.
        </p>
        {storageStatus === "in-memory" && (
          <p
            role="status"
            className="text-amber-600 dark:text-amber-500 font-medium"
          >
            Armazenamento local indisponível; preferências mantidas apenas em
            memória nesta sessão.
          </p>
        )}
      </div>

      <DialogFooter className="flex items-center justify-between gap-2 sm:justify-between">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            onReset();
          }}
        >
          <RotateCcw data-icon="inline-start" />
          Restaurar padrão
        </Button>
        {onClose && (
          <Button variant="outline" size="sm" onClick={onClose}>
            Fechar
          </Button>
        )}
      </DialogFooter>
    </>
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

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label="Personalizar painel da visão geral"
      >
        <SlidersHorizontal data-icon="inline-start" />
        Personalizar painel
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="erp-editor sm:max-w-md">
          <OverviewPreferencesForm
            me={me}
            preferences={preferences}
            storageStatus={storageStatus}
            onToggleWidget={onToggleWidget}
            onReset={onReset}
            onClose={() => setOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
