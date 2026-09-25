export type MachineFuelTotal = {
  equipmentId: string | null;
  name: string;
  kind: string;
  liters: number;
  loads: number;
  lastAt: string;
};

export type MachineFuelHistory = { machines: MachineFuelTotal[]; unassigned: MachineFuelTotal | null };
export type MachineFuelLoad = { id: string; occurredAt: string; liters: number; operator: string; reference: string; source: string };
export type MachineFuelLoads = { movements: MachineFuelLoad[]; total: number; page: number; pageSize: number };

export function machineCategory(kind: string): string {
  const value = kind.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (/tractor/.test(value)) return "Tractor";
  if (/trilladora|cosechadora/.test(value)) return "Cosechadora / trilladora";
  if (/camioneta/.test(value)) return "Camioneta";
  if (/camion/.test(value)) return "Camión";
  return "Otro";
}

export function rankMachines(machines: MachineFuelTotal[], kind = "all", search = "") {
  const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("es");
  const query = normalize(search.trim());
  const filtered = machines.filter((machine) => (kind === "all" || machineCategory(machine.kind) === kind)
    && normalize(`${machine.name} ${machine.equipmentId ?? ""}`).includes(query))
    .sort((a, b) => b.liters - a.liters || a.name.localeCompare(b.name, "es", { numeric: true }) || (a.equipmentId ?? "").localeCompare(b.equipmentId ?? ""));
  const total = filtered.reduce((sum, item) => sum + item.liters, 0);
  let rank = 0;
  return filtered.map((machine, index) => {
    // Competition ranking: tied quantities share a place (1°, 1°, 3°).
    if (index === 0 || Math.abs(machine.liters - filtered[index - 1].liters) > 1e-8) rank = index + 1;
    return { ...machine, rank, share: total > 0 ? machine.liters / total * 100 : 0 };
  });
}
