import React, { useState } from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radius, font } from "@/src/theme";

interface DaySummary {
  date: string; // YYYY-MM-DD
  patient_count: number;
  tokens: number[];
}

interface CalendarSummaryProps {
  summaryData: DaySummary[];
  onSelectDate?: (date: string) => void;
}

export default function CalendarSummary({ summaryData, onSelectDate }: CalendarSummaryProps) {
  const [currentMonthDate, setCurrentMonthDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<string>(new Date().toISOString().split("T")[0]);

  const mapByDate = (summaryData || []).reduce((acc, item) => {
    acc[item.date] = item;
    return acc;
  }, {} as Record<string, DaySummary>);

  const year = currentMonthDate.getFullYear();
  const month = currentMonthDate.getMonth();

  const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDayOfWeek = new Date(year, month, 1).getDay(); // 0 is Sun

  const daysArray = [];
  for (let i = 0; i < firstDayOfWeek; i++) {
    daysArray.push(null);
  }
  for (let d = 1; d <= daysInMonth; d++) {
    daysArray.push(d);
  }

  const prevMonth = () => {
    setCurrentMonthDate(new Date(year, month - 1, 1));
  };

  const nextMonth = () => {
    setCurrentMonthDate(new Date(year, month + 1, 1));
  };

  const handleSelectDay = (day: number) => {
    const formattedMonth = String(month + 1).padStart(2, "0");
    const formattedDay = String(day).padStart(2, "0");
    const isoDate = `${year}-${formattedMonth}-${formattedDay}`;
    setSelectedDate(isoDate);
    if (onSelectDate) onSelectDate(isoDate);
  };

  const selectedDayInfo = mapByDate[selectedDate];

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.monthTitle}>
          {monthNames[month]} {year}
        </Text>
        <View style={styles.navBtns}>
          <Pressable onPress={prevMonth} style={styles.navBtn}>
            <Ionicons name="chevron-back" size={20} color={colors.onSurface} />
          </Pressable>
          <Pressable onPress={nextMonth} style={styles.navBtn}>
            <Ionicons name="chevron-forward" size={20} color={colors.onSurface} />
          </Pressable>
        </View>
      </View>

      {/* Weekday Labels */}
      <View style={styles.weekRow}>
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day, idx) => (
          <Text key={idx} style={styles.weekLabel}>
            {day}
          </Text>
        ))}
      </View>

      {/* Grid */}
      <View style={styles.grid}>
        {daysArray.map((day, idx) => {
          if (day === null) {
            return <View key={idx} style={styles.dayCellEmpty} />;
          }

          const formattedMonth = String(month + 1).padStart(2, "0");
          const formattedDay = String(day).padStart(2, "0");
          const isoDate = `${year}-${formattedMonth}-${formattedDay}`;
          const dayInfo = mapByDate[isoDate];
          const isSelected = isoDate === selectedDate;
          const hasBookings = dayInfo && dayInfo.patient_count > 0;

          return (
            <Pressable
              key={idx}
              onPress={() => handleSelectDay(day)}
              style={[
                styles.dayCell,
                isSelected && styles.dayCellSelected,
                hasBookings && !isSelected && styles.dayCellHasBookings,
              ]}
            >
              <Text style={[styles.dayText, isSelected && styles.dayTextSelected]}>{day}</Text>
              {hasBookings && (
                <View style={[styles.badge, isSelected && styles.badgeSelected]}>
                  <Text style={[styles.badgeText, isSelected && styles.badgeTextSelected]}>
                    {dayInfo.patient_count}
                  </Text>
                </View>
              )}
            </Pressable>
          );
        })}
      </View>

      {/* Selected Day Summary Footer */}
      <View style={styles.summaryFooter}>
        <Text style={styles.summaryTitle}>
          Summary for {selectedDate}:
        </Text>
        {selectedDayInfo ? (
          <View style={styles.summaryDetails}>
            <Text style={styles.summaryText}>
              📊 Total Booked Patients: <Text style={styles.bold}>{selectedDayInfo.patient_count}</Text>
            </Text>
            {selectedDayInfo.tokens && selectedDayInfo.tokens.length > 0 && (
              <Text style={styles.summaryText}>
                🎟️ Active Tokens: {selectedDayInfo.tokens.slice(0, 10).map((t) => `#${t}`).join(", ")}
                {selectedDayInfo.tokens.length > 10 ? "..." : ""}
              </Text>
            )}
          </View>
        ) : (
          <Text style={styles.summaryMuted}>No booked appointments for this date.</Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.sm,
  },
  monthTitle: {
    fontSize: font.base,
    fontWeight: "700",
    color: colors.onSurface,
  },
  navBtns: {
    flexDirection: "row",
    gap: spacing.xs,
  },
  navBtn: {
    padding: spacing.xs,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceSecondary,
  },
  weekRow: {
    flexDirection: "row",
    justifyContent: "space-around",
    marginBottom: spacing.xs,
  },
  weekLabel: {
    width: "14%",
    textAlign: "center",
    fontSize: 11,
    color: colors.muted,
    fontWeight: "600",
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
  },
  dayCellEmpty: {
    width: "14%",
    height: 44,
  },
  dayCell: {
    width: "14%",
    height: 44,
    justifyContent: "center",
    alignItems: "center",
    borderRadius: radius.sm,
    marginVertical: 2,
  },
  dayCellSelected: {
    backgroundColor: colors.brand,
  },
  dayCellHasBookings: {
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.brandSecondary,
  },
  dayText: {
    fontSize: font.sm,
    color: colors.onSurface,
  },
  dayTextSelected: {
    color: "#fff",
    fontWeight: "700",
  },
  badge: {
    position: "absolute",
    bottom: 2,
    backgroundColor: colors.brand,
    borderRadius: 8,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  badgeSelected: {
    backgroundColor: "#fff",
  },
  badgeText: {
    fontSize: 9,
    color: "#fff",
    fontWeight: "700",
  },
  badgeTextSelected: {
    color: colors.brand,
  },
  summaryFooter: {
    marginTop: spacing.md,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  summaryTitle: {
    fontSize: font.sm,
    fontWeight: "700",
    color: colors.onSurface,
    marginBottom: 4,
  },
  summaryDetails: {
    gap: 2,
  },
  summaryText: {
    fontSize: 11,
    color: colors.onSurface,
  },
  bold: {
    fontWeight: "700",
  },
  summaryMuted: {
    fontSize: 11,
    color: colors.muted,
    fontStyle: "italic",
  },
});
