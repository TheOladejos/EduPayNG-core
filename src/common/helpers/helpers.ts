export const categorizeData = (items) => {
  return items.reduce((acc, item) => {
    const name = item.name.toLowerCase();
    
    // Extract numbers associated with "day" or "hr" using Regex
    // This matches: "1Day", "7 Days", "24 hrs", etc.
    const dayMatch = name.match(/(\d+)\s*(day|hr)/);
    const days = dayMatch ? parseInt(dayMatch[1]) : 0;

    if (name.includes("monthly") || name.includes("30 day") || name.includes("1 month") || days >= 30) {
      acc.monthly.push(item);
    } 
    else if (name.includes("weekly") || (days >= 7 && days < 30)) {
      acc.weekly.push(item);
    } 
    else if (name.includes("daily") || (days > 0 && days < 7) || name.includes("hr")) {
      acc.daily.push(item);
    } 
    else {
      // For items like "Voice Bundle" with no duration in the name
      acc.others.push(item);
    }

    return acc;
  }, { daily: [], weekly: [], monthly: [], others: [] });
};
