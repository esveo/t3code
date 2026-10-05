import { EsveoSettingBadge } from "../esveoSettings/EsveoSettingBadge";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";

/** Fork (esveo): opt-in catch-up of a fixed-time run missed while the app was off or asleep. */
export function CatchUpMissedRunsField(props: {
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0 space-y-1">
        <span className="inline-flex items-center gap-1.5">
          <Label htmlFor="scheduled-task-catch-up">Catch up missed runs</Label>
          <EsveoSettingBadge />
        </span>
        <p id="scheduled-task-catch-up-description" className="text-sm text-muted-foreground">
          If the app was off or asleep at the scheduled time, run once when it is back instead of
          skipping to the next time.
        </p>
      </div>
      <Switch
        id="scheduled-task-catch-up"
        aria-describedby="scheduled-task-catch-up-description"
        checked={props.checked}
        onCheckedChange={(checked) => props.onCheckedChange(Boolean(checked))}
      />
    </div>
  );
}
