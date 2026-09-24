import { memo, useEffect, useId, useState, useSyncExternalStore } from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import Svg, {
  Circle,
  Defs,
  LinearGradient,
  Path,
  RadialGradient,
  Rect,
  Stop,
} from "react-native-svg";

import type { ThreadFeedEntry } from "../../lib/threadActivity";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import {
  buildEsveoConicWedges,
  ESVEO_ACTION_STOPS,
  ESVEO_LIVE_RING_BASE,
  ESVEO_MIDNIGHT_THEME_ID,
  ESVEO_SEA,
  ESVEO_SKY,
  ESVEO_TILE_STOPS,
  isEsveoLiveUserMessage,
  markEsveoLiveUserMessage,
  subscribeEsveoLiveUserMessages,
} from "./esveoMidnightModel";

/**
 * Fork: esveo Midnight's brand gradients on mobile, the native port of
 * apps/web/src/components/esveoBrand/esveoMidnight.css. Dark mode only, like
 * on web; every other theme renders nothing here. The pieces mount as the
 * first, absolutely positioned child of upstream's bubble and send button, so
 * those files carry one line each.
 */

const USER_BUBBLE_RADIUS = 20;
const CONIC_WEDGES = buildEsveoConicWedges();

function useEsveoMidnightDark(): boolean {
  const { themeId, themeAppearance } = useAppearancePreferences();
  return themeId === ESVEO_MIDNIGHT_THEME_ID && themeAppearance === "dark";
}

function useSvgId(): string {
  return `esveo${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
}

/**
 * Marks the latest user message as live while the thread works, for the
 * circling light on its bubble. Call once per feed.
 */
export function useEsveoLiveUserMessage(
  feed: ReadonlyArray<ThreadFeedEntry>,
  isWorking: boolean,
): void {
  let liveMessageId: string | null = null;
  if (isWorking) {
    const entry = feed.findLast(
      (candidate) => candidate.type === "message" && candidate.message.role === "user",
    );
    liveMessageId = entry?.type === "message" ? entry.message.id : null;
  }
  useEffect(
    () => (liveMessageId === null ? undefined : markEsveoLiveUserMessage(liveMessageId)),
    [liveMessageId],
  );
}

/** The bubbles' tile: Space navy into Sky ink with a Sea and a Sky glow in the corners. */
function EsveoTile() {
  const id = useSvgId();
  return (
    <Svg style={StyleSheet.absoluteFill} width="100%" height="100%" preserveAspectRatio="none">
      <Defs>
        {/* CSS 160deg: top left-of-centre to bottom right-of-centre. */}
        <LinearGradient id={`${id}base`} x1="0.32" y1="0" x2="0.68" y2="1">
          <Stop offset="0" stopColor={ESVEO_TILE_STOPS[0]} />
          <Stop offset="0.6" stopColor={ESVEO_TILE_STOPS[1]} />
          <Stop offset="1" stopColor={ESVEO_TILE_STOPS[2]} />
        </LinearGradient>
        <RadialGradient id={`${id}sea`} cx="1" cy="0" fx="1" fy="0" r="1.05">
          <Stop offset="0" stopColor={ESVEO_SEA} stopOpacity={0.13} />
          <Stop offset="0.55" stopColor={ESVEO_SEA} stopOpacity={0} />
        </RadialGradient>
        <RadialGradient id={`${id}sky`} cx="0" cy="1" fx="0" fy="1" r="0.9">
          <Stop offset="0" stopColor={ESVEO_SKY} stopOpacity={0.09} />
          <Stop offset="0.6" stopColor={ESVEO_SKY} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Rect width="100%" height="100%" fill={`url(#${id}base)`} />
      <Rect width="100%" height="100%" fill={`url(#${id}sea)`} />
      <Rect width="100%" height="100%" fill={`url(#${id}sky)`} />
    </Svg>
  );
}

/**
 * The light circling the running turn's bubble. It only rotates, on the UI
 * thread, so the wedges are drawn once and never repainted.
 */
function EsveoLiveLight({ size }: { size: number }) {
  const reduceMotion = useReducedMotion();
  const rotation = useSharedValue(0);
  useEffect(() => {
    if (reduceMotion) return;
    // One surge and one lull per circle, as on web.
    rotation.value = withRepeat(
      withTiming(360, { duration: 3600, easing: Easing.bezier(0.35, 0.05, 0.65, 0.95) }),
      -1,
      false,
    );
    return () => cancelAnimation(rotation);
  }, [reduceMotion, rotation]);
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        {
          position: "absolute",
          top: "50%",
          left: "50%",
          width: size,
          height: size,
          marginTop: -size / 2,
          marginLeft: -size / 2,
        },
        animatedStyle,
      ]}
    >
      <Svg width={size} height={size} viewBox="-1 -1 2 2">
        {CONIC_WEDGES.map((wedge) => (
          <Path key={wedge.path} d={wedge.path} fill={wedge.fill} fillOpacity={wedge.opacity} />
        ))}
      </Svg>
    </Animated.View>
  );
}

function EsveoUserBubbleFill({ messageId }: { messageId: string }) {
  const live = useSyncExternalStore(subscribeEsveoLiveUserMessages, () =>
    isEsveoLiveUserMessage(messageId),
  );
  const [diagonal, setDiagonal] = useState(0);
  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setDiagonal(Math.ceil(Math.hypot(width, height)));
  };
  return (
    <View
      pointerEvents="none"
      onLayout={live ? onLayout : undefined}
      style={[
        StyleSheet.absoluteFill,
        {
          borderRadius: USER_BUBBLE_RADIUS,
          overflow: "hidden",
          backgroundColor: live ? ESVEO_LIVE_RING_BASE : undefined,
        },
      ]}
    >
      {live && diagonal > 0 ? <EsveoLiveLight size={diagonal} /> : null}
      {/* While live, a 1px edge stays free for the ring; the tile's corners stay concentric. */}
      <View
        style={{
          position: "absolute",
          top: live ? 1 : 0,
          right: live ? 1 : 0,
          bottom: live ? 1 : 0,
          left: live ? 1 : 0,
          borderRadius: live ? USER_BUBBLE_RADIUS - 1 : USER_BUBBLE_RADIUS,
          overflow: "hidden",
        }}
      >
        <EsveoTile />
      </View>
    </View>
  );
}

/** First child of a user message bubble: the Midnight tile, and the ring while its turn runs. */
export const EsveoUserBubbleBackdrop = memo(function EsveoUserBubbleBackdrop({
  messageId,
}: {
  messageId: string;
}) {
  return useEsveoMidnightDark() ? <EsveoUserBubbleFill messageId={messageId} /> : null;
});

function EsveoActionGradient() {
  const id = useSvgId();
  return (
    <Svg style={StyleSheet.absoluteFill} width="100%" height="100%" viewBox="0 0 2 2">
      <Defs>
        <LinearGradient id={`${id}action`} x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor={ESVEO_ACTION_STOPS[0]} />
          <Stop offset="0.5" stopColor={ESVEO_ACTION_STOPS[1]} />
          <Stop offset="1" stopColor={ESVEO_ACTION_STOPS[2]} />
        </LinearGradient>
      </Defs>
      <Circle cx="1" cy="1" r="1" fill={`url(#${id}action)`} />
    </Svg>
  );
}

/** First child of the composer's round primary action: Sky into the Sky-Sea mid. */
export const EsveoActionFill = memo(function EsveoActionFill({ active }: { active: boolean }) {
  return useEsveoMidnightDark() && active ? <EsveoActionGradient /> : null;
});
