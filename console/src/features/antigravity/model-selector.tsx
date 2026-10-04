import {
  antigravityModelGroups,
  antigravityVariant,
} from "../../../../src/shared/antigravity-models.ts";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

export function AntigravityModelSelector({
  models,
  value,
  onChange,
}: {
  models: ReadonlyMap<string, string>;
  value: readonly string[];
  onChange: (models: string[]) => void;
}) {
  const selectedModels = new Set(value);
  const toggle = (ids: string[], checked: boolean) =>
    onChange(
      checked
        ? [...new Set([...value, ...ids])]
        : value.filter((model) => !ids.includes(model)),
    );
  return (
    <div className="relative grid max-h-80 gap-3 overflow-auto rounded-md border p-3">
      {[...antigravityModelGroups([...models.keys()])].map(([id, variants]) => {
        const family = !variants.includes(id);
        const selected = variants.filter((model) => selectedModels.has(model));
        return (
          <div key={id} className="space-y-2">
            <Label className="flex items-center gap-3 text-sm">
              <Checkbox
                checked={
                  selected.length === variants.length
                    ? true
                    : selected.length
                      ? "indeterminate"
                      : false
                }
                onCheckedChange={(checked) =>
                  toggle(variants, checked === true)
                }
              />
              <span>
                {family ? id : models.get(id)}
                {!family && (
                  <span className="ml-2 font-mono text-xs text-muted-foreground">
                    {id}
                  </span>
                )}
              </span>
            </Label>
            {family && (
              <details className="ml-7 text-xs text-muted-foreground">
                <summary className="cursor-pointer">
                  Thinking levels:{" "}
                  {selected
                    .map((model) => antigravityVariant(model)?.level)
                    .join(", ") || "none selected"}
                </summary>
                <div className="mt-2 flex gap-4">
                  {variants.map((model) => (
                    <Label key={model} className="flex items-center gap-2">
                      <Checkbox
                        aria-label={`${id} ${antigravityVariant(model)?.level}`}
                        checked={selectedModels.has(model)}
                        onCheckedChange={(checked) =>
                          toggle([model], checked === true)
                        }
                      />
                      {antigravityVariant(model)?.level}
                    </Label>
                  ))}
                </div>
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}
