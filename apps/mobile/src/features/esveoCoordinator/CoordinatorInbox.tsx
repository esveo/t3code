/**
 * Fork: a coordinator's Inbox on the phone, as the desktop's Inbox tab shows
 * it: one decision at a time with arrows, the question and its explanation,
 * the options as boxes and a free-text box for everything else. Answers
 * collect until Send hands them to the coordinator together.
 */
import type { ScopedThreadRef, ThreadDecision } from "@t3tools/contracts";
import {
  type DecisionDraft,
  draftToReply,
  hasDraft,
  orderDecisions,
} from "@t3tools/shared/threadInbox";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { useAtomCommand } from "../../state/use-atom-command";
import { coordinatorEnvironment } from "./coordinatorState";

const ACCENT = "#6ea8ff";

export function CoordinatorInbox(props: {
  readonly threadRef: ScopedThreadRef;
  readonly decisions: ReadonlyArray<ThreadDecision>;
}) {
  const act = useAtomCommand(coordinatorEnvironment.act, {
    label: "send inbox answers",
    reportFailure: true,
  });
  const [drafts, setDrafts] = useState<Readonly<Record<string, DecisionDraft>>>({});
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const ordered = useMemo(() => orderDecisions(props.decisions), [props.decisions]);
  // An answered decision stays current, so typing a note never jumps ahead.
  const current =
    ordered.find((decision) => decision.id === currentId) ??
    ordered.find((decision) => !hasDraft(drafts[decision.id])) ??
    ordered[0] ??
    null;
  const index = current ? ordered.indexOf(current) : -1;
  const ready = ordered.filter((decision) => hasDraft(drafts[decision.id]));

  const answer = (decisionId: string, patch: Partial<DecisionDraft>) => {
    setCurrentId(decisionId);
    setDrafts((all) => ({ ...all, [decisionId]: { ...all[decisionId], ...patch } }));
  };
  const send = async () => {
    const replies = ready.flatMap((decision) => {
      const reply = draftToReply(decision.id, drafts[decision.id]!);
      return reply ? [reply] : [];
    });
    if (replies.length === 0 || sending) return;
    setSending(true);
    const result = await act({
      environmentId: props.threadRef.environmentId,
      input: { type: "submit", threadId: props.threadRef.threadId, replies },
    });
    setSending(false);
    if (result._tag !== "Success") return;
    setDrafts((all) => {
      const next = { ...all };
      for (const reply of replies) delete next[reply.decisionId];
      return next;
    });
  };

  if (!current) {
    return (
      <View className="flex-1 px-4 pt-6">
        <Text className="text-base font-t3-medium text-foreground">Nothing is waiting on you</Text>
      </View>
    );
  }
  const draft = drafts[current.id];

  return (
    <View className="flex-1">
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-5 px-4 pt-4 pb-6"
        keyboardShouldPersistTaps="handled"
      >
        <View className="flex-row items-center justify-between">
          <Text className="text-sm text-foreground-muted">
            Decision {index + 1} of {ordered.length}
          </Text>
          <View className="flex-row gap-2">
            <ArrowButton
              label="Previous decision"
              glyph="‹"
              disabled={index <= 0}
              onPress={() => setCurrentId(ordered[index - 1]?.id ?? null)}
            />
            <ArrowButton
              label="Next decision"
              glyph="›"
              disabled={index >= ordered.length - 1}
              onPress={() => setCurrentId(ordered[index + 1]?.id ?? null)}
            />
          </View>
        </View>

        <View className="gap-2">
          <Text className="text-base font-t3-medium text-foreground">{current.question}</Text>
          {current.context ? (
            <Text className="text-sm text-foreground-muted">{current.context}</Text>
          ) : null}
        </View>

        <View className="gap-2">
          {current.kind === "task" ? (
            <AnswerBox
              selected={draft?.done === true}
              label="Done"
              onPress={() => answer(current.id, { done: draft?.done !== true })}
            />
          ) : null}
          {current.options.map((option) => {
            const selected = draft?.optionId === option.id;
            const recommended = current.recommendedOptionId === option.id;
            return (
              <AnswerBox
                key={option.id}
                selected={selected}
                label={option.label}
                recommended={recommended}
                detail={[option.detail, recommended ? current.recommendationReason : null]
                  .filter(Boolean)
                  .join(" ")}
                onPress={() => answer(current.id, { optionId: selected ? undefined : option.id })}
              />
            );
          })}
          <TextInput
            multiline
            value={draft?.text ?? ""}
            onChangeText={(text) => answer(current.id, { text })}
            placeholder={
              draft?.optionId || draft?.done
                ? "A note to your answer"
                : "Your own answer, a question back, or a note"
            }
            placeholderTextColor="#8b93a1"
            accessibilityLabel="Your own answer or a note"
            className="min-h-20 rounded-xl px-3 py-2.5 text-sm text-foreground"
            style={{
              borderWidth: 1,
              borderStyle: draft?.text ? "solid" : "dashed",
              borderColor: draft?.text ? ACCENT : "#3a404c",
              textAlignVertical: "top",
            }}
          />
        </View>
      </ScrollView>

      <View className="flex-row items-center gap-3 border-t border-border-subtle px-4 py-3">
        <Text className="flex-1 text-sm text-foreground-muted">
          {ready.length > 0
            ? `${ready.length} answer${ready.length === 1 ? "" : "s"} ready`
            : "No answers yet"}
        </Text>
        <Pressable
          accessibilityRole="button"
          disabled={ready.length === 0 || sending}
          onPress={() => void send()}
          className={cn(
            "min-h-11 justify-center rounded-xl px-4",
            ready.length === 0 && "opacity-40",
          )}
          style={{ backgroundColor: ACCENT }}
        >
          <Text className="font-t3-medium" style={{ color: "#0b1220" }}>
            Send{ready.length > 0 ? ` ${ready.length}` : ""}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function ArrowButton(props: {
  readonly label: string;
  readonly glyph: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      className={cn(
        "size-11 items-center justify-center rounded-xl border border-border",
        props.disabled && "opacity-40",
      )}
    >
      <Text className="text-lg text-foreground">{props.glyph}</Text>
    </Pressable>
  );
}

function AnswerBox(props: {
  readonly selected: boolean;
  readonly label: string;
  readonly recommended?: boolean;
  readonly detail?: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: props.selected }}
      onPress={props.onPress}
      className="flex-row gap-3 rounded-xl px-3 py-3"
      style={{ borderWidth: 1, borderColor: props.selected ? ACCENT : "#3a404c" }}
    >
      <View
        className="mt-0.5 size-4 rounded-full"
        style={{
          borderWidth: props.selected ? 5 : 2,
          borderColor: props.selected ? ACCENT : "#8b93a1",
        }}
      />
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-sm font-t3-medium text-foreground">
          {props.label}
          {props.recommended ? <Text className="text-foreground-muted"> (recommended)</Text> : null}
        </Text>
        {props.detail ? (
          <Text className="text-sm text-foreground-muted">{props.detail}</Text>
        ) : null}
      </View>
    </Pressable>
  );
}
