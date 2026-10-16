import { EsveoSettingBadge } from "../esveoSettings/EsveoSettingBadge";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";

/** Fork (esveo): a thread-bound automation runs each trigger as a subthread of its thread. */
export function SpawnAsSubthreadField(props: {
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0 space-y-1">
        <span className="inline-flex items-center gap-1.5">
          <Label htmlFor="scheduled-task-spawn-subthread">Spawn as subthread</Label>
          <EsveoSettingBadge />
        </span>
        <p
          id="scheduled-task-spawn-subthread-description"
          className="text-sm text-muted-foreground"
        >
          Each run starts a new thread under the bound thread instead of posting there. The bound
          thread hears back when the subthread is done.
        </p>
      </div>
      <Switch
        id="scheduled-task-spawn-subthread"
        aria-describedby="scheduled-task-spawn-subthread-description"
        checked={props.checked}
        onCheckedChange={(checked) => props.onCheckedChange(Boolean(checked))}
      />
    </div>
  );
}
