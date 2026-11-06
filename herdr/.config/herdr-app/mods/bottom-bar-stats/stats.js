export const STATS_PROBE = `
os=$(uname -s)
case "$os" in
  MINGW*|MSYS*|CYGWIN*)
    if command -v powershell.exe >/dev/null 2>&1; then
      psu=$(powershell.exe -NoProfile -Command '$cpu=(Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor | Where-Object Name -eq "_Total").PercentProcessorTime; $os=Get-CimInstance Win32_OperatingSystem; "cpu=$cpu"; "mem=$($os.TotalVisibleMemorySize*1024) $($os.FreePhysicalMemory*1024)"')
      printf '%s\\n' "$psu"
      drive=$(echo "$SYSTEMDRIVE" | tr -d ':' | tr '[:upper:]' '[:lower:]')
      [ -d "/$drive" ] || drive=c
      df -Pk "/$drive" | awk 'NR==2{print "disk="$2" "$3" "$4}'
    fi
    ;;
  *)
    if [ -r /proc/loadavg ]; then echo "load=$(cut -d' ' -f1-3 /proc/loadavg)"; else echo "load=$(sysctl -n vm.loadavg | tr -d '{}')"; fi
    echo "cpus=$(nproc 2>/dev/null || sysctl -n hw.ncpu)"
    if command -v free >/dev/null 2>&1; then free -b | awk '/^Mem:/{print "mem="$2" "$7}'
    elif command -v vm_stat >/dev/null 2>&1; then echo "mem=$(sysctl -n hw.memsize) $(vm_stat | awk '/page size of/{ps=$8} /Pages free/{f=$3} /Pages inactive/{i=$3} /Pages speculative/{s=$3} END{print (f+i+s)*ps}')"; fi
    root=/; [ -d /System/Volumes/Data ] && root=/System/Volumes/Data
    df -Pk "$root" | awk 'NR==2{print "disk="$2" "$3" "$4}'
    ;;
esac
`;

const number = (text) => Number(String(text).trim().replace(",", "."));

export function parseStats(out) {
  const stats = { cpu: null, load: null, cpus: null, mem: null, disk: null };
  for (const line of out.split("\n")) {
    const at = line.indexOf("=");
    if (at < 0) continue;
    const key = line.slice(0, at);
    const value = line.slice(at + 1);
    const parts = value.trim().split(/\s+/).map(number);
    if (key === "cpu" && Number.isFinite(parts[0])) stats.cpu = parts[0];
    if (key === "load") stats.load = parts.slice(0, 3);
    if (key === "cpus" && Number.isFinite(parts[0])) stats.cpus = parts[0];
    if (key === "mem" && parts.length === 2) stats.mem = { total: parts[0], available: parts[1] };
    if (key === "disk" && parts.length === 3) stats.disk = { total: parts[0] * 1024, used: parts[1] * 1024, free: parts[2] * 1024 };
  }
  return stats;
}

export function statsUsage(stats) {
  const pct = (part, whole) => (whole > 0 ? Math.min(100, Math.round((part / whole) * 100)) : null);
  const cpu = Number.isFinite(stats.cpu)
    ? Math.min(100, Math.round(stats.cpu))
    : stats.load && stats.cpus
      ? pct(stats.load[0], stats.cpus)
      : null;
  return {
    cpu,
    mem: stats.mem ? pct(stats.mem.total - stats.mem.available, stats.mem.total) : null,
    disk: stats.disk ? pct(stats.disk.used, stats.disk.used + stats.disk.free) : null,
  };
}
