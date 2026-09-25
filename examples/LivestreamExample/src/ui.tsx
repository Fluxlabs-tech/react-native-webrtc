import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import type { LivestreamState } from 'react-native-webrtc';

export const colors = {
  background: '#F2F3F5',
  card: '#FFFFFF',
  text: '#15171A',
  muted: '#6B7280',
  border: '#E3E5E8',
  accent: '#E11D48',
  accentText: '#FFFFFF',
  video: '#0B0C0E',
  good: '#16A34A',
  warn: '#D97706',
  bad: '#DC2626',
};

export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <View style={styles.card}>
      {title ? <Text style={styles.cardTitle}>{title}</Text> : null}
      {children}
    </View>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  disabled,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <View style={[styles.segmented, disabled && styles.disabled]}>
      {options.map((option) => (
        <Pressable
          key={option.value}
          disabled={disabled}
          onPress={() => onChange(option.value)}
          style={[styles.segment, option.value === value && styles.segmentActive]}>
          <Text style={[styles.segmentText, option.value === value && styles.segmentTextActive]}>
            {option.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  editable = true,
  secure,
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  editable?: boolean;
  secure?: boolean;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={[styles.input, !editable && styles.disabled]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="#A0A4AB"
        autoCapitalize="none"
        autoCorrect={false}
        editable={editable}
        secureTextEntry={secure}
      />
    </View>
  );
}

export function Button({
  title,
  onPress,
  kind = 'primary',
  disabled,
}: {
  title: string;
  onPress: () => void;
  kind?: 'primary' | 'secondary';
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        kind === 'secondary' && styles.buttonSecondary,
        (pressed || disabled) && styles.pressed,
      ]}>
      <Text style={[styles.buttonText, kind === 'secondary' && styles.buttonTextSecondary]}>{title}</Text>
    </Pressable>
  );
}

export function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Switch value={value} onValueChange={onChange} />
    </View>
  );
}

/** Label and value pairs, two to a line. */
export function Stats({ items }: { items: [string, string][] }) {
  return (
    <View style={styles.stats}>
      {items.map(([label, value]) => (
        <View key={label} style={styles.stat}>
          <Text style={styles.statLabel}>{label}</Text>
          <Text style={styles.statValue}>{value}</Text>
        </View>
      ))}
    </View>
  );
}

const STATE_COLORS: Record<LivestreamState, string> = {
  idle: colors.muted,
  connecting: colors.warn,
  connected: colors.good,
  offline: colors.muted,
  reconnecting: colors.warn,
  failed: colors.bad,
  stopped: colors.muted,
};

export function StatusLine({ state, reason }: { state: LivestreamState; reason?: string }) {
  return (
    <View style={styles.status}>
      <View style={[styles.dot, { backgroundColor: STATE_COLORS[state] }]} />
      <Text style={styles.statusText} numberOfLines={2}>
        {state}
        {reason ? ` · ${reason}` : ''}
      </Text>
    </View>
  );
}

/** A level from -60 to 0 dBFS as a bar. */
export function Meter({ label, db, max = 0 }: { label: string; db: number; max?: number }) {
  const fraction = Math.max(0, Math.min(1, (db + 60) / (60 + max)));
  return (
    <View style={styles.meter}>
      <Text style={styles.meterLabel}>{label}</Text>
      <View style={styles.meterTrack}>
        <View style={[styles.meterFill, { width: `${fraction * 100}%` }]} />
      </View>
      <Text style={styles.meterValue}>{db <= -120 ? '—' : `${db.toFixed(0)} dB`}</Text>
    </View>
  );
}

export const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: 14,
    marginHorizontal: 16,
    marginTop: 12,
    gap: 10,
  },
  cardTitle: { fontSize: 13, fontWeight: '600', color: colors.muted, textTransform: 'uppercase' },
  segmented: { flexDirection: 'row', backgroundColor: colors.background, borderRadius: 10, padding: 3 },
  segment: { flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: 'center' },
  segmentActive: { backgroundColor: colors.card, shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 3, elevation: 1 },
  segmentText: { fontSize: 14, color: colors.muted, fontWeight: '500' },
  segmentTextActive: { color: colors.text },
  field: { gap: 4 },
  label: { fontSize: 12, color: colors.muted },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    color: colors.text,
  },
  button: { backgroundColor: colors.accent, borderRadius: 10, paddingVertical: 12, alignItems: 'center', flex: 1 },
  buttonSecondary: { backgroundColor: colors.background },
  buttonText: { color: colors.accentText, fontSize: 15, fontWeight: '600' },
  buttonTextSecondary: { color: colors.text },
  pressed: { opacity: 0.6 },
  disabled: { opacity: 0.5 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowLabel: { fontSize: 15, color: colors.text },
  buttons: { flexDirection: 'row', gap: 10 },
  stats: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 8 },
  stat: { width: '50%' },
  statLabel: { fontSize: 11, color: colors.muted },
  statValue: { fontSize: 14, color: colors.text, fontVariant: ['tabular-nums'] },
  status: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { fontSize: 13, color: colors.text, flex: 1 },
  meter: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  meterLabel: { width: 52, fontSize: 12, color: colors.muted },
  meterTrack: { flex: 1, height: 6, borderRadius: 3, backgroundColor: colors.background, overflow: 'hidden' },
  meterFill: { height: 6, backgroundColor: colors.good },
  meterValue: { width: 52, fontSize: 12, color: colors.text, textAlign: 'right', fontVariant: ['tabular-nums'] },
  hint: { fontSize: 12, color: colors.muted },
  video: { backgroundColor: colors.video, marginHorizontal: 16, marginTop: 12, borderRadius: 14, overflow: 'hidden' },
  videoOverlay: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center' },
  videoOverlayText: { color: '#C9CDD3', fontSize: 14 },
});
