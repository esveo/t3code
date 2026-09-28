import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { EsveoWordmark } from "./EsveoWordmark";

/**
 * Fork: the esveo build's header title, in place of upstream's "T3 Code ALPHA" lockup
 * (components/CompactBrandTitle.tsx), with the same offset and heading semantics.
 */
export function EsveoCompactBrandTitle(props: { readonly marginLeft: number }) {
  return (
    <View
      aria-level={1}
      accessibilityLabel="esveo code, Threads"
      accessible
      role="heading"
      style={{ marginLeft: props.marginLeft }}
    >
      <EsveoWordmark height={22} />
    </View>
  );
}

/** Fork: the esveo build's loading-screen lockup, in place of components/BrandMark.tsx. */
export function EsveoBrandMark(props: { readonly compact: boolean }) {
  return (
    <View className="gap-1.5">
      <EsveoWordmark height={props.compact ? 24 : 32} />
      {!props.compact ? (
        <Text className="text-xs font-medium text-foreground-muted">
          Mobile control surface for your live coding environments
        </Text>
      ) : null}
    </View>
  );
}
