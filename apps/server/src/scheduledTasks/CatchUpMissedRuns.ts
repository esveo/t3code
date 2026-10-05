import type { ScheduledTask, ScheduledTaskSchedule } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

/**
 * Fork (esveo): whether a missed fixed-time run fires once on the next poll
 * instead of being skipped. Opt-in per task; upstream always skips.
 */
export function catchesUpMissedRuns(schedule: ScheduledTaskSchedule): boolean {
  return schedule.type === "fixed_time" && schedule.catchUpMissedRuns === true;
}

/**
 * Fork (esveo): fires a missed run once. The run completes like any other and
 * plans the next occurrence from the completion time, so however many slots
 * were missed, only one run catches up.
 */
export const catchUpMissedRun = <A, E, R>(
  task: ScheduledTask,
  runTask: (task: ScheduledTask, trigger: "scheduled") => Effect.Effect<A, E, R>,
) =>
  Effect.logInfo("Catching up missed schedule task run", {
    taskId: task.id,
    missedRunAt: task.nextRunAt,
  }).pipe(Effect.andThen(runTask(task, "scheduled")));
