import { appKeyNameError } from "@rome/api-types/app-keys";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, KeyRound, Plus, RefreshCw } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, EmptyStateIcon, EmptyStateTitle } from "@/components/ui/empty-state";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { RomeConfirmDialog } from "@/components/rome-confirm-dialog";
import { type AppKeyDto, deleteAppKey, fetchAppKeys, saveAppKey } from "@/lib/app-keys-api";

const QUERY_KEY = ["app-keys"];

/** Blank form for "add"; prefilled name+label (value always retyped) for
 * "replace". The value is write-only end to end: the API never returns it, so
 * the form never has anything to show back. */
type FormState = { mode: "add" } | { mode: "replace"; name: string; label: string };

export function AppKeysSection() {
  const { t } = useTranslation("settings");
  const uid = useId();
  const queryClient = useQueryClient();
  const keysQuery = useQuery({ queryKey: QUERY_KEY, queryFn: fetchAppKeys });

  const [form, setForm] = useState<FormState | null>(null);
  const [label, setLabel] = useState("");
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<AppKeyDto | null>(null);

  const openForm = (next: FormState) => {
    setForm(next);
    setLabel(next.mode === "replace" ? next.label : "");
    setName(next.mode === "replace" ? next.name : "");
    setValue("");
    setFormError(null);
  };
  const closeForm = () => {
    setForm(null);
    setValue("");
    setFormError(null);
  };

  const saveMutation = useMutation({
    mutationFn: saveAppKey,
    onSuccess: async (result, input) => {
      closeForm();
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      if (result.overridden) {
        toast.warning(t("appKeys.savedOverridden"));
      } else {
        toast.success(t("appKeys.saved", { name: input.name }));
      }
    },
    onError: (error: Error) => setFormError(error.message),
  });

  const removeMutation = useMutation({
    mutationFn: deleteAppKey,
    onSuccess: async (_result, removedName) => {
      setRemoving(null);
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      toast.success(t("appKeys.removed", { name: removedName }));
    },
    onError: (error: Error) => {
      setRemoving(null);
      toast.error(error.message);
    },
  });

  const submit = () => {
    const trimmedName = name.trim();
    const nameError = appKeyNameError(trimmedName);
    if (nameError) {
      setFormError(nameError);
      return;
    }
    if (!value) {
      setFormError(t("appKeys.form.valueRequired"));
      return;
    }
    saveMutation.mutate({ name: trimmedName, label: label.trim() || trimmedName, value });
  };

  const keys = keysQuery.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-title text-foreground">{t("appKeys.title")}</h2>
          <p className="mt-1 text-body text-muted-foreground">{t("appKeys.subtitle")}</p>
        </div>
        {form === null && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => openForm({ mode: "add" })}
          >
            <Plus aria-hidden />
            {t("appKeys.add")}
          </Button>
        )}
      </div>

      {keysQuery.isLoading ? (
        <div className="flex flex-col gap-2" role="status" aria-label={t("appKeys.loading")}>
          {[0, 1].map((index) => (
            <Skeleton key={index} className="h-14 w-full" />
          ))}
        </div>
      ) : keysQuery.isError ? (
        <Alert variant="destructive">
          <CircleAlert aria-hidden />
          <AlertTitle>{t("appKeys.errorTitle")}</AlertTitle>
          <AlertDescription>
            <p>{keysQuery.error.message}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => void keysQuery.refetch()}
            >
              <RefreshCw aria-hidden />
              {t("page.retry")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : keys.length === 0 && form === null ? (
        <EmptyState className="rounded-8 border border-dashed border-border bg-surface/50">
          <EmptyStateIcon>
            <KeyRound aria-hidden />
          </EmptyStateIcon>
          <EmptyStateTitle>{t("appKeys.emptyTitle")}</EmptyStateTitle>
          <p className="text-body text-muted-foreground">{t("appKeys.emptyBody")}</p>
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-2">
          {keys.map((key) => (
            <li
              key={key.name}
              className="flex items-center justify-between gap-3 rounded-8 border border-border bg-surface px-4 py-3"
            >
              <div className="min-w-0">
                <p className="truncate text-ui text-foreground">{key.label}</p>
                <p className="truncate font-mono text-body text-muted-foreground">{key.name}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {key.overridden ? (
                  <Badge variant="warning" title={t("appKeys.overriddenHint")}>
                    {t("appKeys.overridden")}
                  </Badge>
                ) : (
                  <Badge variant="success">{t("appKeys.set")}</Badge>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => openForm({ mode: "replace", name: key.name, label: key.label })}
                >
                  {t("appKeys.replace")}
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => setRemoving(key)}>
                  {t("appKeys.remove")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {form !== null && (
        <form
          className="space-y-4 rounded-8 border border-border bg-surface p-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Field>
            <FieldLabel htmlFor={`${uid}-app-key-label`}>{t("appKeys.form.labelField")}</FieldLabel>
            <Input
              id={`${uid}-app-key-label`}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t("appKeys.form.labelPlaceholder")}
              className="w-full"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${uid}-app-key-name`}>{t("appKeys.form.nameField")}</FieldLabel>
            <Input
              id={`${uid}-app-key-name`}
              value={name}
              onChange={(e) => setName(e.target.value.toUpperCase())}
              placeholder={t("appKeys.form.namePlaceholder")}
              disabled={form.mode === "replace"}
              className="w-full font-mono"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${uid}-app-key-value`}>{t("appKeys.form.valueField")}</FieldLabel>
            <Input
              id={`${uid}-app-key-value`}
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoComplete="off"
              className="w-full"
            />
            <p className="mt-1 text-body text-muted-foreground">{t("appKeys.form.valueHint")}</p>
          </Field>
          {formError && <p className="text-body text-destructive">{formError}</p>}
          <div className="flex items-center justify-between gap-3">
            <p className="text-body text-muted-foreground">{t("appKeys.form.consent")}</p>
            <div className="flex shrink-0 gap-2">
              <Button type="button" variant="outline" size="sm" onClick={closeForm}>
                {t("appKeys.form.cancel")}
              </Button>
              <Button type="submit" size="sm" disabled={saveMutation.isPending}>
                {saveMutation.isPending ? t("appKeys.form.saving") : t("appKeys.form.save")}
              </Button>
            </div>
          </div>
        </form>
      )}

      <RomeConfirmDialog
        open={removing !== null}
        title={t("appKeys.removeTitle", { name: removing?.name ?? "" })}
        description={t("appKeys.removeBody")}
        destructive
        confirmLabel={t("appKeys.remove")}
        confirmDisabled={removeMutation.isPending}
        onConfirm={() => {
          if (removing) removeMutation.mutate(removing.name);
        }}
        onCancel={() => setRemoving(null)}
      />
    </div>
  );
}
