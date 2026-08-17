"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

type ManagedEntityType = "operators" | "equipment" | "associations";
type EquipmentKind = "Tractor" | "Trilladora" | "Cuatrimoto";
type EnrollmentAssignment = { name: string; kind: EquipmentKind; validUntil: string };

type View =
  | "overview"
  | "machineMap"
  | "transactions"
  | "fuelHistory"
  | "operators"
  | "rfidCredentials"
  | "equipment"
  | "associations"
  | "alerts"
  | "access"
  | "system";

type Modal =
  | { type: "operator" }
  | { type: "equipment" }
  | { type: "association" }
  | { type: "enroll"; operatorId: string; operatorName: string; credentialIsMaster: boolean }
  | { type: "createCredential" }
  | { type: "rfidAssignment"; credentialId?: string }
  | { type: "deleteCredential"; credentialId: string }
  | { type: "identifyCredential" }
  | { type: "transaction"; id: string }
  | { type: "equipmentDetail"; id: string }
  | { type: "equipmentEnrollment"; moduleId: string }
  | { type: "alertDetail"; alertId: string }
  | { type: "permanentDelete"; entityType: ManagedEntityType; id: string; name: string }
  | null;

type Operator = {
  id: string;
  name: string;
  rut: string;
  credential: string;
  credentialActive: boolean;
  credentialIsMaster: boolean;
  active: boolean;
  lastUse: string;
  archivedAt?: string | null;
};

type IdentifiedCredential = {
  credentialId: string;
  registered: boolean;
  operator: Pick<Operator, "id" | "name" | "rut" | "active" | "credentialActive" | "credentialIsMaster" | "archivedAt"> | null;
};

type RfidCredential = {
  credentialId: string;
  credentialActive: boolean;
  credentialIsMaster: boolean;
  operatorId: string | null;
  operatorName: string | null;
  operatorRut: string | null;
  operatorActive: boolean;
  operatorArchivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type Equipment = {
  id: string;
  name: string;
  kind: EquipmentKind;
  condition: "Permanente" | "Temporal" | "Externo";
  module: string;
  siteId: string;
  active: boolean;
  expiry?: string | null;
  assignmentExpired?: boolean;
  assignmentExpiringSoon?: boolean;
  archivedAt?: string | null;
};

type EnrollmentCandidate = {
  moduleId: string;
  siteId: string;
  deviceName: string | null;
  equipmentId: string | null;
  firmware: string;
  rssi: number;
  claimed: boolean;
  status: "detected" | "pending" | "enrolling" | "failed" | "enrolled";
  lastSeen: string;
  commandId: string | null;
  requestedName: string | null;
  requestedKind: EquipmentKind | null;
  validUntil: string | null;
  error: string | null;
};

type EquipmentScan = {
  id: string;
  status: "pending" | "scanning" | "completed" | "failed";
  durationSeconds: number;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  discovered: number;
  verified: number;
  error: string | null;
};

type NetworkScanState = "idle" | "scanning" | "updated" | "failed";

type BluetoothSettings = {
  siteId: string;
  rssiThreshold: number;
  revision: number;
  updatedAt: string;
  appliedThreshold: number | null;
  appliedRevision: number | null;
  appliedAt: string | null;
  lastObservedRssi: number | null;
  lastObservedModule: string | null;
  observedAt: string | null;
};

type BluetoothObservation = {
  moduleId: string;
  equipmentId: string;
  name: string;
  kind: EquipmentKind;
  rssi: number;
  observedAt: string;
};

type RelayTestCommand = {
  id: string;
  status: "pending" | "running" | "completed" | "failed" | "expired";
  durationSeconds: 10;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  expiresAt: string;
  error: string | null;
};

type Association = {
  id: string;
  operatorId: string;
  equipmentId: string;
  active: boolean;
  since: string;
  archivedAt?: string | null;
};

type AlertPriority = "urgent" | "high" | "medium" | "low";
type AlertStatus = "pending" | "in_progress" | "resolved";
type AlertComment = {
  id: string;
  actor: string;
  comment: string;
  statusAfter: AlertStatus;
  priorityAfter: AlertPriority;
  recordedAt: string;
};
type AlertItem = {
  id: string;
  severity: "critical" | "warning" | "info";
  priority: AlertPriority;
  status: AlertStatus;
  title: string;
  detail: string;
  time: string;
  acknowledged: boolean;
  comments?: AlertComment[];
};

type Transaction = {
  id: string;
  occurredAt: string;
  time: string;
  operator: string;
  equipment: string;
  liters: number;
  duration: string;
  status: "Completada" | "Interrumpida" | "Excepcional";
  validation: string;
  source: string;
};

type TransactionStatusFilter = "Todas" | Transaction["status"];

type FuelMovement = {
  id: string;
  type: "receipt" | "dispatch";
  occurredAt: string;
  liters: number;
  openingLevel: number;
  closingLevel: number;
  source: string;
  reference: string;
  detail: string;
  operatorId?: string | null;
  operatorName?: string | null;
  equipmentId?: string | null;
  equipmentName?: string | null;
  isMaster?: boolean;
  detectedAutomatically: boolean;
  confidence: number;
  status: "confirmed" | "accumulating";
};

type FuelHistoryResponse = {
  movements: FuelMovement[];
  summary: { receivedLiters: number; dispatchedLiters: number; netLiters: number; movementCount: number };
  sensor: { capacityLiters: number; currentLevel: number; latestReadingAt: string; receiptThresholdLiters: number; detectionStatus: "monitoring" | "detecting" };
  edge: { moduleId: string; siteId: string; state: string; relayEnergized: boolean; validatorOnline: boolean; nfcReady: boolean; k24Enabled: boolean; k24Healthy: boolean; tankLevelEnabled: boolean; occurredAt: string } | null;
};

type AuthUser = {
  name: string;
  role: string;
  roleCode: string;
  permissions: Permission[];
  mustChangePassword: boolean;
};

type Permission = "view_dashboard" | "view_transactions" | "manage_alerts" | "manage_operators" | "manage_equipment" | "manage_associations" | "manage_users" | "manage_system";
type UserRole = "master" | "administrator" | "supervisor" | "viewer";
type WebUser = {
  id: string;
  email: string | null;
  name: string;
  role: UserRole;
  permissions: Permission[];
  active: boolean;
  mustChangePassword: boolean;
  isMaster: boolean;
  createdAt: string;
  lastLoginAt: string | null;
};

type AuthState =
  | { status: "checking" }
  | { status: "signed-out" }
  | { status: "signed-in"; user: AuthUser };

const SITE_VERSION = "V.1.5.2";

const seedOperators: Operator[] = [];

const seedEquipment: Equipment[] = [];

const initialTransactions: Transaction[] = [];

const seedAssociations: Association[] = [];

const seedAlerts: AlertItem[] = [];

const navItems: { id: View; label: string; short: string; group: "operate" | "manage" | "support" }[] = [
  { id: "overview", label: "Resumen", short: "RE", group: "operate" },
  { id: "transactions", label: "Cargas", short: "CA", group: "operate" },
  { id: "fuelHistory", label: "Histórico combustible", short: "HC", group: "operate" },
  { id: "alerts", label: "Alertas", short: "AL", group: "operate" },
  { id: "operators", label: "Operadores", short: "OP", group: "manage" },
  { id: "equipment", label: "Equipos", short: "EQ", group: "manage" },
  { id: "associations", label: "Asociaciones", short: "AS", group: "manage" },
  { id: "access", label: "Usuarios", short: "US", group: "support" },
  { id: "system", label: "Sistema", short: "SI", group: "support" },
];

const viewCopy: Record<View, { eyebrow: string; title: string; description: string }> = {
  overview: { eyebrow: "Operación local", title: "Fundo Santa Isabel", description: "Visión en tiempo real del abastecimiento y la infraestructura edge." },
  machineMap: { eyebrow: "Activos · Equipos abastecibles", title: "Mapa de máquinas", description: "MIMs visibles y autenticados por el validador, ubicados según la intensidad Bluetooth recibida." },
  transactions: { eyebrow: "Trazabilidad", title: "Cargas de combustible", description: "Cada despacho conserva identidad, volumen, tiempo y evidencia de validación." },
  fuelHistory: { eyebrow: "Inventario y trazabilidad", title: "Histórico de combustible", description: "Analiza recepciones, despachos y variaciones del nivel del estanque a través del tiempo." },
  operators: { eyebrow: "Personas", title: "Operadores", description: "Administra quién puede abastecer y el estado de sus credenciales NFC." },
  rfidCredentials: { eyebrow: "Personas · Operadores", title: "Credenciales RFID", description: "Enrola, identifica y vincula tags con un único operador vigente." },
  equipment: { eyebrow: "Activos", title: "Equipos abastecibles", description: "Inventario permanente, temporal y externo asociado al fundo." },
  associations: { eyebrow: "Autorizaciones", title: "Asociaciones vigentes", description: "Define qué operador está autorizado para abastecer cada equipo." },
  alerts: { eyebrow: "Supervisión", title: "Alertas", description: "Eventos accionables de inventario, validación y salud del sistema." },
  access: { eyebrow: "Seguridad", title: "Usuarios y permisos", description: "Enrola cuentas, asigna roles y controla el acceso efectivo al sistema." },
  system: { eyebrow: "Infraestructura", title: "Salud del sistema", description: "Estado del controlador, sensores, comunicaciones y respaldos locales." },
};

export default function Home() {
  const [auth, setAuth] = useState<AuthState>({ status: "checking" });
  const [authError, setAuthError] = useState("");
  const [view, setView] = useState<View>("overview");
  const [menuOpen, setMenuOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [transactionStatus, setTransactionStatus] = useState<TransactionStatusFilter>("Todas");
  const [modal, setModal] = useState<Modal>(null);
  const [toast, setToast] = useState("");
  const [operators, setOperators] = useState<Operator[]>(seedOperators);
  const [rfidCredentials, setRfidCredentials] = useState<RfidCredential[]>([]);
  const [equipment, setEquipment] = useState<Equipment[]>(seedEquipment);
  const [enrollmentCandidates, setEnrollmentCandidates] = useState<EnrollmentCandidate[]>([]);
  const [equipmentScan, setEquipmentScan] = useState<EquipmentScan | null>(null);
  const [networkScanState, setNetworkScanState] = useState<NetworkScanState>("idle");
  const networkScanTimer = useRef<number | null>(null);
  const [machineObservations, setMachineObservations] = useState<BluetoothObservation[]>([]);
  const [associations, setAssociations] = useState<Association[]>(seedAssociations);
  const [alerts, setAlerts] = useState<AlertItem[]>(seedAlerts);
  const [transactions, setTransactions] = useState<Transaction[]>(initialTransactions);
  const [fuelSensor, setFuelSensor] = useState<FuelHistoryResponse["sensor"] | null>(null);
  const [edgeStatus, setEdgeStatus] = useState<FuelHistoryResponse["edge"]>(null);
  const [entityError, setEntityError] = useState("");
  const [entitiesLoading, setEntitiesLoading] = useState(false);
  const [rfidLoading, setRfidLoading] = useState(false);
  const [clock, setClock] = useState("");
  const [nowMs, setNowMs] = useState(0);

  const refreshEntities = useCallback(async () => {
    const response = await fetch("/api/managed-entities", { credentials: "same-origin", cache: "no-store" });
    const body = await response.json() as { operators?: Operator[]; equipment?: Equipment[]; associations?: Association[]; error?: string };
    if (!response.ok || !body.operators || !body.equipment || !body.associations) throw new Error(body.error ?? "No fue posible cargar los registros.");
    setOperators(body.operators);
    setEquipment(body.equipment);
    setAssociations(body.associations);
  }, []);
  const refreshAlerts = useCallback(async () => {
    const response = await fetch("/api/alerts", { credentials: "same-origin", cache: "no-store" });
    const body = await response.json() as { alerts?: AlertItem[]; error?: string };
    if (!response.ok || !body.alerts) throw new Error(body.error ?? "No fue posible cargar las alertas.");
    setAlerts(body.alerts);
  }, []);
  const refreshRfidCredentials = useCallback(async () => {
    const response = await fetch("/api/rfid-credentials", { credentials: "same-origin", cache: "no-store" });
    const body = await response.json() as { credentials?: RfidCredential[]; error?: string };
    if (!response.ok || !body.credentials) throw new Error(body.error ?? "No fue posible cargar las credenciales RFID.");
    setRfidCredentials(body.credentials);
  }, []);
  const refreshEnrollment = useCallback(async () => {
    const response = await fetch("/api/equipment-enrollment", { credentials: "same-origin", cache: "no-store" });
    const body = await response.json() as { candidates?: EnrollmentCandidate[]; scan?: EquipmentScan | null; error?: string };
    if (!response.ok || !body.candidates) throw new Error(body.error ?? "No fue posible consultar los MIM por Wi-Fi.");
    setEnrollmentCandidates(body.candidates);
    setEquipmentScan(body.scan ?? null);
    if (body.candidates.some((candidate) => candidate.status === "enrolled")) await refreshEntities();
  }, [refreshEntities]);
  const refreshTransactions = useCallback(async () => {
    const now = new Date();
    const fromDate = new Date(now);
    fromDate.setFullYear(fromDate.getFullYear() - 1);
    const response = await fetch(`/api/fuel-history?from=${dateInputValue(fromDate)}&to=${dateInputValue(now)}`, {
      credentials: "same-origin", cache: "no-store",
    });
    const body = await response.json() as FuelHistoryResponse & { error?: string };
    if (!response.ok) throw new Error(body.error ?? "No fue posible cargar las transacciones.");
    setTransactions(body.movements.filter((item) => item.type === "dispatch").map(movementToTransaction));
    setFuelSensor(body.sensor);
    setEdgeStatus(body.edge);
  }, []);
  const refreshOperationalStatus = useCallback(async () => {
    const response = await fetch("/api/fuel-history/status", { credentials: "same-origin", cache: "no-store" });
    const body = await response.json() as { edge?: FuelHistoryResponse["edge"]; sensor?: FuelHistoryResponse["sensor"]; error?: string };
    if (!response.ok) throw new Error(body.error ?? "No fue posible consultar el estado operacional.");
    setEdgeStatus(body.edge ?? null);
    setFuelSensor(body.sensor ?? null);
  }, []);
  const refreshMachineMap = useCallback(async () => {
    const response = await fetch("/api/system-settings/bluetooth/observations", { credentials: "same-origin", cache: "no-store" });
    const body = await response.json() as { observations?: BluetoothObservation[]; error?: string };
    if (!response.ok || !body.observations) throw new Error(body.error ?? "No fue posible consultar los MIM enlazados.");
    setMachineObservations(body.observations);
  }, []);
  const canLoadManagedEntities = auth.status === "signed-in"
    && auth.user.permissions.some((permission) => ["manage_operators", "manage_equipment", "manage_associations"].includes(permission));

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/auth/session", {
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) {
        setAuth({ status: "signed-out" });
        return;
      }
      const body = await response.json() as { authenticated: boolean; user?: AuthUser };
      setAuth(body.authenticated && body.user
        ? { status: "signed-in", user: body.user }
        : { status: "signed-out" });
    }).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setAuthError("No fue posible verificar el acceso al equipo edge.");
      setAuth({ status: "signed-out" });
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!canLoadManagedEntities) return;
    const frame = window.requestAnimationFrame(() => {
      setEntitiesLoading(true);
      setEntityError("");
      refreshEntities().catch((error: unknown) => setEntityError(error instanceof Error ? error.message : "No fue posible cargar los registros."))
        .finally(() => setEntitiesLoading(false));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [canLoadManagedEntities, refreshEntities]);

  useEffect(() => {
    if (auth.status !== "signed-in" || view !== "rfidCredentials" || !auth.user.permissions.includes("manage_operators")) return;
    const frame = window.requestAnimationFrame(() => {
      setRfidLoading(true);
      setEntityError("");
      Promise.all([refreshEntities(), refreshRfidCredentials()])
        .catch((error: unknown) => setEntityError(error instanceof Error ? error.message : "No fue posible cargar el inventario RFID."))
        .finally(() => setRfidLoading(false));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [auth, view, refreshEntities, refreshRfidCredentials]);

  useEffect(() => {
    if (auth.status !== "signed-in") return;
    const frame = window.requestAnimationFrame(() => {
      Promise.all([refreshAlerts(), refreshTransactions()]).catch((error: unknown) => setEntityError(error instanceof Error ? error.message : "No fue posible cargar la operación."));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [auth.status, refreshAlerts, refreshTransactions]);

  useEffect(() => {
    if (auth.status !== "signed-in" || !["overview", "equipment"].includes(view) || !auth.user.permissions.includes("manage_equipment")) return;
    let active = true;
    let refreshing = false;
    const refresh = () => {
      if (refreshing) return;
      refreshing = true;
      refreshEnrollment().catch((error: unknown) => {
        if (active) setEntityError(error instanceof Error ? error.message : "No fue posible consultar los MIM por Wi-Fi.");
      }).finally(() => { refreshing = false; });
    };
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [auth, view, refreshEnrollment]);

  useEffect(() => {
    if (auth.status !== "signed-in") return;
    let refreshing = false;
    const refresh = () => {
      if (refreshing) return;
      refreshing = true;
      Promise.all([
        refreshOperationalStatus(),
        refreshAlerts(),
        refreshTransactions(),
      ]).catch(() => undefined).finally(() => { refreshing = false; });
    };
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => window.clearInterval(timer);
  }, [auth.status, refreshAlerts, refreshOperationalStatus, refreshTransactions]);

  useEffect(() => {
    if (auth.status !== "signed-in" || view !== "machineMap") return;
    let refreshing = false;
    const refresh = () => {
      if (refreshing) return;
      refreshing = true;
      refreshMachineMap().catch((error: unknown) => setEntityError(error instanceof Error ? error.message : "No fue posible consultar el mapa de máquinas."))
        .finally(() => { refreshing = false; });
    };
    refresh();
    const timer = window.setInterval(refresh, 1000);
    return () => window.clearInterval(timer);
  }, [auth.status, view, refreshMachineMap]);

  useEffect(() => {
    const refreshClock = () => {
      const now = new Date();
      setNowMs(now.getTime());
      setClock(
        new Intl.DateTimeFormat("es-CL", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }).format(now),
      );
    };
    const frame = window.requestAnimationFrame(refreshClock);
    const timer = window.setInterval(refreshClock, 1000);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => () => {
    if (networkScanTimer.current !== null) window.clearTimeout(networkScanTimer.current);
  }, []);

  const openView = (next: View) => {
    setView(next);
    setSearch("");
    if (next === "transactions") setTransactionStatus("Todas");
    setMenuOpen(false);
  };

  const visibleTransactions = transactions.filter((item) => {
    const matchesSearch = `${item.id} ${item.operator} ${item.equipment}`.toLowerCase().includes(search.toLowerCase());
    const matchesStatus = transactionStatus === "Todas" || item.status === transactionStatus;
    return matchesSearch && matchesStatus;
  });

  const downloadCsv = (items: Transaction[] = transactions) => {
    const header = "ID,Fecha,Operador,Equipo,Litros,Duración,Estado,Validación";
    const rows = items.map((item) =>
      [item.id, item.time, item.operator, item.equipment, item.liters.toFixed(1), item.duration, item.status, item.validation]
        .map((value) => `"${String(value).replaceAll('"', '""')}"`)
        .join(","),
    );
    const url = URL.createObjectURL(new Blob([[header, ...rows].join("\n")], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "cargas-fundo-santa-isabel-2026-08-10.csv";
    link.click();
    URL.revokeObjectURL(url);
    setToast("Exportación preparada correctamente");
  };

  const managedRequest = async (type: ManagedEntityType, method: "POST" | "PATCH" | "DELETE", payload?: object, id?: string) => {
    setEntityError("");
    const response = await fetch(`/api/managed-entities/${type}${id ? `/${encodeURIComponent(id)}` : ""}`, {
      method,
      credentials: "same-origin",
      headers: payload ? { "Content-Type": "application/json" } : undefined,
      body: payload ? JSON.stringify(payload) : undefined,
    });
    const body = await response.json() as { error?: string };
    if (!response.ok) throw new Error(body.error ?? "No fue posible actualizar el registro.");
    await refreshEntities();
  };

  const updateManaged = async (type: ManagedEntityType, id: string, payload: object, success: string) => {
    try { await managedRequest(type, "PATCH", payload, id); setToast(success); }
    catch (error) { setEntityError(error instanceof Error ? error.message : "No fue posible actualizar el registro."); }
  };

  const createManaged = async (type: ManagedEntityType, payload: object, success: string) => {
    try { await managedRequest(type, "POST", payload); setModal(null); setToast(success); }
    catch (error) { setEntityError(error instanceof Error ? error.message : "No fue posible crear el registro."); }
  };

  const enrollEquipment = async (moduleId: string, assignment: EnrollmentAssignment) => {
    const response = await fetch(`/api/equipment-enrollment/${encodeURIComponent(moduleId)}/claim`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(assignment),
    });
    const body = await response.json() as { accepted?: boolean; error?: string };
    if (!response.ok || !body.accepted) throw new Error(body.error ?? "No fue posible iniciar el enrolamiento.");
    setModal(null);
    setToast("Asignación enviada. La Raspberry la entregará al MIM por la red Wi-Fi local.");
    await refreshEnrollment();
  };

  const requestEquipmentScan = async () => {
    try {
      await refreshEnrollment();
      setToast("Lista actualizada. Los MIM nuevos aparecen automáticamente al conectarse a la Raspberry.");
    } catch (error) {
      setEntityError(error instanceof Error ? error.message : "No fue posible actualizar los MIM conectados.");
    }
  };

  const startNetworkScan = async () => {
    if (networkScanTimer.current !== null) return;
    setEntityError("");
    setNetworkScanState("scanning");
    networkScanTimer.current = window.setTimeout(() => {
      networkScanTimer.current = null;
      setNetworkScanState("updated");
      setToast("Red actualizada");
      refreshEnrollment().catch((error: unknown) => {
        setNetworkScanState("failed");
        setEntityError(error instanceof Error ? error.message : "No fue posible actualizar los equipos conectados.");
      });
    }, 10_000);
    try {
      const response = await fetch("/api/equipment-enrollment/scan", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body = await response.json() as { scan?: EquipmentScan; error?: string };
      if (!response.ok || !body.scan) throw new Error(body.error ?? "No fue posible iniciar el escaneo de red.");
      setEquipmentScan(body.scan);
    } catch (error) {
      if (networkScanTimer.current !== null) window.clearTimeout(networkScanTimer.current);
      networkScanTimer.current = null;
      setNetworkScanState("failed");
      setEntityError(error instanceof Error ? error.message : "No fue posible iniciar el escaneo de red.");
    }
  };

  const permanentlyDelete = async (type: ManagedEntityType, id: string) => {
    try { await managedRequest(type, "DELETE", undefined, id); setModal(null); setToast("Registro eliminado definitivamente de la base local"); }
    catch (error) { setEntityError(error instanceof Error ? error.message : "No fue posible eliminar el registro."); setModal(null); }
  };
  const assignRfid = async (credentialId: string, operatorId: string | null) => {
    const response = await fetch(`/api/rfid-credentials/${encodeURIComponent(credentialId)}`, {
      method: "PATCH", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operatorId }),
    });
    const body = await response.json() as { updated?: boolean; error?: string };
    if (!response.ok || !body.updated) throw new Error(body.error ?? "No fue posible actualizar la vinculación RFID.");
    await Promise.all([refreshEntities(), refreshRfidCredentials()]);
    setModal(null);
    setToast(operatorId ? "Credencial vinculada al operador" : "Credencial RFID desvinculada");
  };
  const unassignRfid = async (credentialId: string) => {
    try { await assignRfid(credentialId, null); }
    catch (error) { setEntityError(error instanceof Error ? error.message : "No fue posible desvincular la credencial RFID."); }
  };
  const deleteRfid = async (credentialId: string) => {
    try {
      const response = await fetch(`/api/rfid-credentials/${encodeURIComponent(credentialId)}`, {
        method: "DELETE", credentials: "same-origin",
      });
      const body = await response.json() as { deleted?: boolean; error?: string };
      if (!response.ok || !body.deleted) throw new Error(body.error ?? "No fue posible eliminar la credencial RFID.");
      await Promise.all([refreshEntities(), refreshRfidCredentials()]);
      setModal(null);
      setToast("Credencial eliminada de la base local y retirada del validador");
    } catch (error) {
      setEntityError(error instanceof Error ? error.message : "No fue posible eliminar la credencial RFID.");
      setModal(null);
    }
  };
  const updateAlert = async (alertId: string, update: { description: string; status: AlertStatus; priority: AlertPriority }) => {
    const response = await fetch(`/api/alerts/${encodeURIComponent(alertId)}/action`, {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update),
    });
    const body = await response.json() as { updated?: boolean; resolved?: boolean; error?: string };
    if (!response.ok || !body.updated) throw new Error(body.error ?? "No fue posible registrar el seguimiento.");
    await refreshAlerts();
    setToast(body.resolved ? "Seguimiento registrado y alerta resuelta" : "Seguimiento agregado; la alerta continúa abierta");
  };

  const resetFuelData = async (password: string) => {
    const response = await fetch("/api/fuel-history/reset", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const body = await response.json() as {
      reset?: boolean;
      sensor?: FuelHistoryResponse["sensor"];
      deleted?: { movements: number; readings: number };
      error?: string;
    };
    if (!response.ok || !body.reset || !body.sensor) {
      throw new Error(body.error ?? "No fue posible reiniciar la base de carga y nivel.");
    }
    setTransactions([]);
    setFuelSensor(body.sensor);
    setToast("Base de carga y nivel reiniciada. El registro en terreno puede comenzar.");
  };

  const currentCopy = viewCopy[view];
  const pendingAlerts = alerts.filter((item) => item.status !== "resolved").length;
  const edgeOnline = Boolean(edgeStatus && nowMs > 0 && nowMs - new Date(edgeStatus.occurredAt).getTime() <= 30_000);
  const validatorConnected = Boolean(edgeOnline && edgeStatus?.validatorOnline);

  const createOperator = async (item: Operator) => {
    await managedRequest("operators", "POST", item);
    setModal(null);
    setToast("Operador creado. Ya puedes enrolar su credencial.");
  };

  const login = async (email: string, password: string) => {
    setAuthError("");
    const response = await fetch("/api/auth/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const body = await response.json() as { error?: string; authenticated?: boolean; user?: AuthUser };
    if (!response.ok || !body.authenticated || !body.user) {
      throw new Error(body.error ?? "No fue posible iniciar sesión.");
    }
    setAuth({ status: "signed-in", user: body.user });
  };

  const logout = async () => {
    setProfileOpen(false);
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    } finally {
      setAuth({ status: "signed-out" });
      setView("overview");
      setModal(null);
    }
  };

  if (auth.status === "checking") return <AuthLoading />;
  if (auth.status === "signed-out") {
    return <LoginScreen initialError={authError} onLogin={login} />;
  }
  const currentUser = auth.user;
  const changeOwnPassword = async (newPassword: string) => {
    const response = await fetch("/api/auth/change-password", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newPassword }),
    });
    const body = await response.json() as { error?: string; changed?: boolean };
    if (!response.ok || !body.changed) throw new Error(body.error ?? "No fue posible cambiar la contraseña.");
    setAuth({ status: "signed-in", user: { ...currentUser, mustChangePassword: false } });
  };
  if (currentUser.mustChangePassword) {
    return <PasswordChangeScreen user={currentUser} onChange={changeOwnPassword} onLogout={logout} />;
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Saltar al contenido</a>
      <Sidebar view={view} open={menuOpen} edgeOnline={edgeOnline} validatorConnected={validatorConnected} alertCount={pendingAlerts} permissions={currentUser.permissions} onNavigate={openView} onClose={() => setMenuOpen(false)} />

      <div className="app-main">
        <header className="topbar">
          <div className="topbar-left">
            <button className="icon-button menu-button" type="button" aria-label="Abrir navegación" onClick={() => setMenuOpen(true)}>
              <span /><span /><span />
            </button>
            <div className="site-location" aria-label="Locación">
              <span className="site-indicator" />
              <span><small>Locación</small><strong>Fundo Santa Isabel</strong></span>
            </div>
          </div>
          <div className="topbar-center" aria-label="Estado de conexión">
            <span className={`online-dot ${validatorConnected ? "" : "offline"}`} /> <strong>{validatorConnected ? "Validador conectado" : "Validador no conectado"}</strong><span className="topbar-edge-state">{edgeOnline ? "Edge en línea" : "Edge sin reporte"}</span><span className="topbar-time">{clock}</span>
          </div>
          <div className="topbar-actions">
            <button className="icon-button notification-button" aria-label={`${pendingAlerts} alertas pendientes`} onClick={() => openView("alerts")}>
              <span aria-hidden="true">!</span>{pendingAlerts > 0 && <b>{pendingAlerts}</b>}
            </button>
            <div className="profile-wrap">
              <button className="profile-button" type="button" aria-expanded={profileOpen} onClick={() => setProfileOpen(!profileOpen)}>
                <span className="avatar">PC</span><span className="profile-copy"><strong>{currentUser.name}</strong><small>{currentUser.role}</small></span><span className="chevron">⌄</span>
              </button>
              {profileOpen && (
                <div className="profile-menu">
                  <strong>{currentUser.name}</strong><span>{currentUser.role}</span>
                  <hr />
                  {currentUser.permissions.includes("manage_users") && <button type="button" onClick={() => { openView("access"); setProfileOpen(false); }}>Administrar usuarios</button>}
                  <button type="button" onClick={logout}>Cerrar sesión</button>
                </div>
              )}
            </div>
          </div>
        </header>

        <main id="main-content" className="content">
          <section className="page-heading">
            <div><span className="eyebrow">{currentCopy.eyebrow}</span><h1>{currentCopy.title}</h1><p>{currentCopy.description}</p></div>
            <ViewActions view={view} permissions={currentUser.permissions} isProviderAdmin={currentUser.roleCode === "master"} onNavigate={openView} onModal={setModal} onExport={() => downloadCsv(visibleTransactions)} exportDisabled={visibleTransactions.length === 0} />
          </section>

          {entityError && <div className="auth-error content-error" role="alert"><span>!</span>{entityError}</div>}
          {(entitiesLoading && ["operators", "equipment", "associations"].includes(view) || rfidLoading && view === "rfidCredentials") && <div className="panel entity-loading" role="status">Cargando registros locales…</div>}

          {view === "overview" && <Overview alerts={alerts} transactions={transactions} sensor={fuelSensor} edge={edgeStatus} edgeOnline={edgeOnline} equipment={equipment} nowMs={nowMs} canScanNetwork={currentUser.permissions.includes("manage_equipment")} networkScanState={networkScanState} onNetworkScan={startNetworkScan} onNavigate={openView} onTransaction={(id) => setModal({ type: "transaction", id })} />}
          {view === "machineMap" && <MachineMap observations={machineObservations} validatorConnected={validatorConnected} nowMs={nowMs} />}
          {view === "transactions" && <Transactions search={search} status={transactionStatus} items={visibleTransactions} allItems={transactions} onSearch={setSearch} onStatus={setTransactionStatus} onExport={() => downloadCsv(visibleTransactions)} onOpen={(id) => setModal({ type: "transaction", id })} />}
          {view === "fuelHistory" && <FuelHistoryView />}
          {view === "operators" && !entitiesLoading && <Operators operators={operators} search={search} isProviderAdmin={currentUser.roleCode === "master"} onSearch={setSearch} onToggle={(item) => updateManaged("operators", item.id, { active: !item.active }, "Estado del operador actualizado")} onArchive={(item, archived) => updateManaged("operators", item.id, { archived }, archived ? "Operador enviado al histórico" : "Operador restaurado")} onDelete={(item) => setModal({ type: "permanentDelete", entityType: "operators", id: item.id, name: item.name })} onReplace={(item) => setModal({ type: "enroll", operatorId: item.id, operatorName: item.name, credentialIsMaster: item.credentialIsMaster })} onCredentials={() => openView("rfidCredentials")} />}
          {view === "rfidCredentials" && !rfidLoading && <RfidCredentialsView credentials={rfidCredentials} operators={operators} isProviderAdmin={currentUser.roleCode === "master"} onIdentify={() => setModal({ type: "identifyCredential" })} onCreate={() => setModal({ type: "createCredential" })} onAssign={(credentialId) => setModal({ type: "rfidAssignment", credentialId })} onUnassign={(credentialId) => void unassignRfid(credentialId)} onDelete={(credentialId) => setModal({ type: "deleteCredential", credentialId })} />}
          {view === "equipment" && !entitiesLoading && <EquipmentView equipment={equipment} candidates={enrollmentCandidates} scan={equipmentScan} search={search} nowMs={nowMs} isProviderAdmin={currentUser.roleCode === "master"} onSearch={setSearch} onToggle={(item) => updateManaged("equipment", item.id, { active: !item.active }, "Estado del equipo actualizado")} onArchive={(item, archived) => updateManaged("equipment", item.id, { archived }, archived ? "Equipo enviado al histórico" : "Equipo restaurado")} onDelete={(item) => setModal({ type: "permanentDelete", entityType: "equipment", id: item.id, name: item.name })} onOpen={(id) => setModal({ type: "equipmentDetail", id })} onEnroll={(moduleId) => setModal({ type: "equipmentEnrollment", moduleId })} onRefresh={requestEquipmentScan} />}
          {view === "associations" && !entitiesLoading && <AssociationsView associations={associations} operators={operators} equipment={equipment} isProviderAdmin={currentUser.roleCode === "master"} onToggle={(item) => updateManaged("associations", item.id, { active: !item.active }, "Asociación actualizada")} onArchive={(item, archived) => updateManaged("associations", item.id, { archived }, archived ? "Asociación enviada al histórico" : "Asociación restaurada")} onDelete={(item, name) => setModal({ type: "permanentDelete", entityType: "associations", id: item.id, name })} />}
          {view === "alerts" && <AlertsView alerts={alerts} canManage={currentUser.permissions.includes("manage_alerts")} onOpen={(id) => setModal({ type: "alertDetail", alertId: id })} />}
          {view === "access" && currentUser.permissions.includes("manage_users") && <AccessView canDeleteUsers={currentUser.roleCode === "master"} />}
          {view === "system" && <SystemView edge={edgeStatus} sensor={fuelSensor} online={edgeOnline} canManage={currentUser.permissions.includes("manage_system")} onRefresh={refreshOperationalStatus} onReset={resetFuelData} />}
        </main>
      </div>

      {modal && <ModalLayer modal={modal} alerts={alerts} transactions={transactions} operators={operators} rfidCredentials={rfidCredentials} equipment={equipment} candidates={enrollmentCandidates} userName={currentUser.name} canManageAlerts={currentUser.permissions.includes("manage_alerts")} isProviderAdmin={currentUser.roleCode === "master"} onClose={() => setModal(null)} onAddOperator={createOperator} onAddEquipment={(item) => createManaged("equipment", item, "Equipo creado correctamente")} onAddAssociation={(item) => createManaged("associations", item, "Asociación creada y vigente")} onEnrollEquipment={enrollEquipment} onNfcEnrolled={async () => { await Promise.all([refreshEntities(), refreshRfidCredentials()]); setToast("Credencial RFID enrolada y sincronizada con la Raspberry"); }} onAssignRfid={assignRfid} onDeleteRfid={deleteRfid} onPermanentDelete={permanentlyDelete} onUpdateAlert={updateAlert} />}
      {toast && <div className="toast" role="status"><span>✓</span>{toast}</div>}
    </div>
  );
}

function AuthLoading() {
  return <main className="auth-shell auth-checking"><section className="auth-card auth-loading" aria-live="polite"><span className="auth-mark">CT</span><div><strong>Concha y Toro - Monitoreo Combustible</strong><p>Verificando acceso…</p></div><span className="auth-spinner" /></section></main>;
}

function LoginScreen({ initialError, onLogin }: { initialError: string; onLogin: (email: string, password: string) => Promise<void> }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(initialError);
  const [recovering, setRecovering] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      await onLogin(String(form.get("email")), String(form.get("password")));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No fue posible iniciar sesión.");
      setSubmitting(false);
    }
  };
  if (recovering) return <RecoveryScreen onBack={() => setRecovering(false)} />;
  return <main className="auth-shell"><section className="auth-card"><div className="auth-brand"><span className="auth-mark">CT</span><div><strong>Concha y Toro -</strong><span>Monitoreo Combustible</span></div></div><div className="auth-copy"><span className="eyebrow">Fundo Santa Isabel</span><h1>Acceso al sistema</h1><p>Ingresa con tu cuenta autorizada para consultar y administrar la operación local.</p></div><form className="auth-form" onSubmit={submit}><label>Correo electrónico<input name="email" type="email" autoComplete="username" required placeholder="nombre@empresa.cl" /></label><label>Contraseña<input name="password" type="password" autoComplete="current-password" required minLength={10} /></label><button className="auth-link" type="button" onClick={() => setRecovering(true)}>¿Olvidaste tu contraseña?</button>{error && <div className="auth-error" role="alert"><span>!</span>{error}</div>}<button className="primary-button" type="submit" disabled={submitting}>{submitting ? "Verificando…" : "Iniciar sesión"}</button></form></section><AuthSide /></main>;
}

function RecoveryScreen({ onBack }: { onBack: () => void }) {
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const newPassword = String(form.get("newPassword"));
    if (newPassword !== String(form.get("confirmation"))) {
      setError("Las contraseñas no coinciden.");
      return;
    }
    setSubmitting(true); setError("");
    const response = await fetch("/api/auth/recover", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: form.get("email"), recoveryCode: form.get("recoveryCode"), newPassword }) });
    const body = await response.json() as { error?: string; recovered?: boolean };
    setSubmitting(false);
    if (!response.ok || !body.recovered) { setError(body.error ?? "No fue posible recuperar el acceso."); return; }
    setSuccess(true);
  };
  return <main className="auth-shell"><section className="auth-card"><div className="auth-brand"><span className="auth-mark">CT</span><div><strong>Recuperación segura</strong><span>Fundo Santa Isabel</span></div></div>{success ? <div className="auth-copy recovery-success"><span className="security-mark">✓</span><h1>Contraseña actualizada</h1><p>Ya puedes iniciar sesión con la nueva contraseña.</p><button className="primary-button" onClick={onBack}>Volver al inicio</button></div> : <><div className="auth-copy"><span className="eyebrow">CUENTA MAESTRA</span><h1>Recuperar acceso</h1><p>Utiliza el código de recuperación guardado fuera de la Raspberry al aprovisionar el sistema.</p></div><form className="auth-form" onSubmit={submit}><label>Correo maestro<input name="email" type="email" autoComplete="username" required /></label><label>Código de recuperación<input name="recoveryCode" autoComplete="off" required placeholder="XXXX-XXXX-XXXX-XXXX-XXXX" /></label><label>Nueva contraseña<input name="newPassword" type="password" autoComplete="new-password" required minLength={12} /></label><label>Repetir nueva contraseña<input name="confirmation" type="password" autoComplete="new-password" required minLength={12} /></label>{error && <div className="auth-error" role="alert"><span>!</span>{error}</div>}<button className="primary-button" disabled={submitting}>{submitting ? "Actualizando…" : "Cambiar contraseña"}</button><button className="auth-link centered" type="button" onClick={onBack}>Volver al inicio de sesión</button></form></>}</section><AuthSide recovery /></main>;
}

function PasswordChangeScreen({ user, onChange, onLogout }: { user: AuthUser; onChange: (password: string) => Promise<void>; onLogout: () => Promise<void> }) {
  const [error, setError] = useState(""); const [submitting, setSubmitting] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); const password = String(form.get("password")); if (password !== String(form.get("confirmation"))) { setError("Las contraseñas no coinciden."); return; } setSubmitting(true); setError(""); try { await onChange(password); } catch (caught) { setError(caught instanceof Error ? caught.message : "No fue posible cambiar la contraseña."); setSubmitting(false); } };
  return <main className="auth-shell"><section className="auth-card"><div className="auth-brand"><span className="auth-mark">{initials(user.name)}</span><div><strong>{user.name}</strong><span>Primer acceso</span></div></div><div className="auth-copy"><span className="eyebrow">PROTECCIÓN DE CUENTA</span><h1>Crea tu contraseña definitiva</h1><p>La clave temporal sólo sirve para este primer ingreso.</p></div><form className="auth-form" onSubmit={submit}><label>Nueva contraseña<input name="password" type="password" autoComplete="new-password" required minLength={12} /></label><label>Repetir contraseña<input name="confirmation" type="password" autoComplete="new-password" required minLength={12} /></label><small className="password-rules">Mínimo 12 caracteres, con mayúscula, minúscula, número y símbolo.</small>{error && <div className="auth-error" role="alert"><span>!</span>{error}</div>}<button className="primary-button" disabled={submitting}>{submitting ? "Guardando…" : "Guardar y continuar"}</button><button className="auth-link centered" type="button" onClick={onLogout}>Cerrar sesión</button></form></section><AuthSide /></main>;
}

function AuthSide({ recovery = false }: { recovery?: boolean }) {
  return <aside className="auth-side"><div><span className="eyebrow">OPERACIÓN LOCAL</span><h2>{recovery ? "Recuperación controlada, sin depender de Internet." : "Control y trazabilidad de petróleo en línea."}</h2></div></aside>;
}

function Sidebar({ view, open, edgeOnline, validatorConnected, alertCount, permissions, onNavigate, onClose }: { view: View; open: boolean; edgeOnline: boolean; validatorConnected: boolean; alertCount: number; permissions: Permission[]; onNavigate: (view: View) => void; onClose: () => void }) {
  const groups = [
    { id: "operate", label: "OPERACIÓN" },
    { id: "manage", label: "ADMINISTRACIÓN" },
    { id: "support", label: "SOPORTE" },
  ] as const;
  return (
    <>
      <button className={`sidebar-scrim ${open ? "visible" : ""}`} aria-label="Cerrar navegación" onClick={onClose} />
      <aside className={`sidebar ${open ? "open" : ""}`} aria-label="Navegación principal">
        <div className="brand"><div className="brand-name">Concha y Toro -<strong>Monitoreo Combustible</strong></div></div>
        <nav>
          {groups.map((group) => (
            <div className="nav-group" key={group.id}>
              <p>{group.label}</p>
              {navItems.filter((item) => item.group === group.id && canOpenView(item.id, permissions)).map((item) => {
                const active = view === item.id || (view === "machineMap" && item.id === "equipment");
                return <button key={item.id} type="button" className={active ? "active" : ""} onClick={() => onNavigate(item.id)} aria-current={active ? "page" : undefined}>
                  <span className="nav-mark">{item.short}</span><span>{item.label}</span>
                  {item.id === "alerts" && alertCount > 0 && <b>{alertCount}</b>}
                </button>;
              })}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer"><div className="sidebar-status"><span className={`edge-pulse ${validatorConnected ? "" : "offline"}`} /><div><strong>{validatorConnected ? "Validador conectado" : "Validador no conectado"}</strong><small>{edgeOnline ? "Controlador edge en línea" : "Controlador sin reporte"}</small></div></div><small className="krontec-copyright">© 2026 by KronTec · {SITE_VERSION}</small></div>
      </aside>
    </>
  );
}

function canOpenView(view: View, permissions: Permission[]) {
  if (view === "overview") return permissions.includes("view_dashboard");
  if (view === "transactions" || view === "fuelHistory") return permissions.includes("view_transactions");
  if (view === "operators" || view === "rfidCredentials") return permissions.includes("manage_operators");
  if (view === "equipment" || view === "machineMap") return permissions.includes("manage_equipment");
  if (view === "associations") return permissions.includes("manage_associations");
  if (view === "access") return permissions.includes("manage_users");
  if (view === "system") return permissions.includes("manage_system");
  return true;
}

function RefreshArrow({ spinning = false }: { spinning?: boolean }) {
  return <svg className={`refresh-arrow ${spinning ? "spinning" : ""}`} viewBox="0 0 20 20" focusable="false" aria-hidden="true"><path d="M15.7 6.6A6.2 6.2 0 1 0 16.1 12" /><path d="M15.8 3.8v3.4h-3.4" /></svg>;
}

function ViewActions({ view, permissions, isProviderAdmin, onNavigate, onModal, onExport, exportDisabled }: { view: View; permissions: Permission[]; isProviderAdmin: boolean; onNavigate: (view: View) => void; onModal: (modal: Modal) => void; onExport: () => void; exportDisabled: boolean }) {
  if (view === "operators" && permissions.includes("manage_operators")) return <div className="page-actions"><button className="secondary-button" type="button" onClick={() => onNavigate("rfidCredentials")}>⌁ Credenciales RFID</button><button className="primary-button" type="button" onClick={() => onModal({ type: "operator" })}>＋ Nuevo operador</button></div>;
  if (view === "rfidCredentials" && permissions.includes("manage_operators")) return <div className="page-actions"><button className="secondary-button" type="button" onClick={() => onNavigate("operators")}>← Operadores</button>{isProviderAdmin && <button className="primary-button" type="button" onClick={() => onModal({ type: "createCredential" })}>＋ Enrolar RFID</button>}</div>;
  if (view === "equipment" && permissions.includes("manage_equipment")) return <button className="secondary-button" type="button" onClick={() => onNavigate("machineMap")}>◎ Ver mapa de máquinas</button>;
  if (view === "machineMap" && permissions.includes("manage_equipment")) return <button className="secondary-button" type="button" onClick={() => onNavigate("equipment")}>← Volver a equipos</button>;
  if (view === "associations" && permissions.includes("manage_associations")) return <button className="primary-button" onClick={() => onModal({ type: "association" })}>＋ Nueva asociación</button>;
  if (view === "transactions") return <button className="secondary-button" onClick={onExport} disabled={exportDisabled}>↓ Exportar CSV</button>;
  return null;
}

function MachineMap({ observations, validatorConnected, nowMs }: { observations: BluetoothObservation[]; validatorConnected: boolean; nowMs: number }) {
  const linked = validatorConnected
    ? observations.filter((item) => nowMs - databaseInstant(item.observedAt).getTime() <= 4_000)
    : [];
  return <section className="machine-map-panel panel" aria-label="Radar de MIM autenticados visibles por el validador">
    <div className="machine-map-status"><span className={`machine-map-live ${validatorConnected ? "" : "offline"}`}><i />{validatorConnected ? "En vivo" : "Validador sin enlace"}</span><strong>{linked.length} {linked.length === 1 ? "MIM visible" : "MIMs visibles"}</strong></div>
    <div className="machine-radar" role="img" aria-label={linked.length ? `Radar con ${linked.length} MIMs visibles` : "Radar sin MIMs visibles"}>
      {[-40, -60, -80, -100].map((level, index) => <div className={`radar-ring ring-${index + 1}`} key={level}><span>{level} dBm</span></div>)}
      <span className="radar-axis horizontal" /><span className="radar-axis vertical" />
      <div className={`radar-validator ${validatorConnected ? "" : "offline"}`}><span>V</span><strong>Validador</strong></div>
      {linked.map((item) => {
        const position = machineRadarPosition(item.moduleId, item.rssi);
        const style = { "--machine-x": `${position.x}%`, "--machine-y": `${position.y}%` } as CSSProperties;
        return <article className="radar-machine" key={item.moduleId} style={style} aria-label={`${item.name}, ${item.rssi} dBm`}>
          <span className="radar-machine-dot"><i /></span>
          <div><strong>{item.name}</strong><span>{item.rssi} dBm</span></div>
        </article>;
      })}
      {linked.length === 0 && <div className="radar-empty"><strong>Sin MIMs visibles</strong><span>{validatorConnected ? "Pulsa el MIM; aparecerá cuando el validador autentique su anuncio." : "Esperando conexión del validador."}</span></div>}
    </div>
    <small className="machine-map-note">Actualización cada segundo. La distancia al centro representa el RSSI; el ángulo sólo separa visualmente los MIM.</small>
  </section>;
}

function machineRadarPosition(moduleId: string, rssi: number) {
  let hash = 2166136261;
  for (const character of moduleId) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const angle = ((hash >>> 0) % 360) * Math.PI / 180;
  const clampedRssi = Math.max(-100, Math.min(-40, rssi));
  const radius = 10 + ((-clampedRssi - 40) / 60) * 37;
  return { x: 50 + Math.cos(angle) * radius, y: 50 + Math.sin(angle) * radius };
}

function databaseInstant(value: string) {
  return new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
}

function Overview({ alerts, transactions, sensor, edge, edgeOnline, equipment, nowMs, canScanNetwork, networkScanState, onNetworkScan, onNavigate, onTransaction }: { alerts: AlertItem[]; transactions: Transaction[]; sensor: FuelHistoryResponse["sensor"] | null; edge: FuelHistoryResponse["edge"]; edgeOnline: boolean; equipment: Equipment[]; nowMs: number; canScanNetwork: boolean; networkScanState: NetworkScanState; onNetworkScan: () => void; onNavigate: (view: View) => void; onTransaction: (id: string) => void }) {
  const todayKey = new Date(nowMs).toDateString();
  const today = transactions.filter((item) => new Date(item.occurredAt).toDateString() === todayKey);
  const todayLiters = today.reduce((total, item) => total + item.liters, 0);
  const weeklyValues = Array.from({ length: 7 }, (_, offset) => {
    const day = new Date(nowMs); day.setHours(0, 0, 0, 0); day.setDate(day.getDate() - (6 - offset));
    const next = new Date(day); next.setDate(next.getDate() + 1);
    return transactions.filter((item) => { const date = new Date(item.occurredAt); return date >= day && date < next; }).reduce((total, item) => total + item.liters, 0);
  });
  const weeklyTotal = weeklyValues.reduce((total, value) => total + value, 0);
  const weeklyMax = Math.max(1, ...weeklyValues);
  const tankPercent = sensor ? Math.max(0, Math.min(100, sensor.currentLevel / sensor.capacityLiters * 100)) : 0;
  const ready = edgeOnline && edge?.state === "locked" && edge.validatorOnline && edge.nfcReady && edge.k24Enabled && edge.k24Healthy;
  const componentHealth = [
    ["PLC", edgeOnline], ["Validador", Boolean(edgeOnline && edge?.validatorOnline)],
    ["NFC", Boolean(edgeOnline && edge?.nfcReady)], ["K24", Boolean(edgeOnline && edge?.k24Enabled && edge?.k24Healthy)],
    ["OCIO", Boolean(edge?.tankLevelEnabled && sensor?.latestReadingAt && !sensor.latestReadingAt.startsWith("1970"))],
  ] as const;
  return (
    <div className="overview-grid">
      <section className="hero-status panel">
        <div className="hero-copy">
          <div className="status-label"><span className={`ready-ring ${ready ? "" : "offline"}`}><i /></span><div><small>ESTADO DEL PUNTO</small><strong>{ready ? "Disponible para una nueva carga" : "Estado operacional sin confirmar"}</strong></div></div>
          <p>{ready ? "Control local en espera. El operador puede presentar su credencial en el validador." : "La aplicación espera un reporte reciente y saludable del controlador antes de mostrar disponibilidad."}</p>
          <div className={`validator-live-state ${edgeOnline && edge?.validatorOnline ? "online" : "offline"}`} role="status" aria-live="polite"><i /><div><small>CONECTIVIDAD DEL VALIDADOR · EN VIVO</small><strong>{edgeOnline && edge?.validatorOnline ? "Validador conectado" : "Validador no conectado"}</strong></div><span>Actualización cada 5 s</span></div>
          <div className="readiness-row">
            {componentHealth.map(([item, healthy]) => <span key={item}><i>{healthy ? "✓" : "·"}</i>{item}</span>)}
          </div>
          {canScanNetwork && <button className={`overview-scan-button ${networkScanState}`} type="button" onClick={onNetworkScan} disabled={networkScanState === "scanning"} aria-busy={networkScanState === "scanning"}><span className="scan-refresh-icon">{networkScanState === "updated" ? "✓" : networkScanState === "failed" ? "!" : <RefreshArrow spinning={networkScanState === "scanning"} />}</span><span aria-live="polite"><strong>{networkScanState === "scanning" ? "Escaneando red…" : networkScanState === "updated" ? "Red actualizada" : networkScanState === "failed" ? "No fue posible actualizar la red" : "Buscar equipos en la red"}</strong><small>{networkScanState === "scanning" ? "La búsqueda finalizará automáticamente en 10 segundos" : networkScanState === "updated" ? "Búsqueda finalizada · Haz clic para buscar nuevamente" : networkScanState === "failed" ? "Haz clic para reintentar la búsqueda" : "Haz clic para iniciar una búsqueda manual de 10 segundos"}</small></span></button>}
          <div className="safety-note"><span>i</span><p><strong>Control seguro en el borde</strong>El dashboard observa la operación. La habilitación física pertenece exclusivamente al PLC.</p></div>
        </div>
        <div className="tank-card">
          <div className="tank-gauge"><div className="tank-fill" style={{ height: `${tankPercent}%` }} /><div className="tank-value"><strong>{Math.round(tankPercent)}%</strong><span>{sensor ? formatCompactLiters(sensor.currentLevel) : "Sin lectura"}</span></div></div>
          <div className="tank-meta"><span>Nivel medido</span><strong>{sensor ? `de ${formatCompactLiters(sensor.capacityLiters)}` : "OCIO pendiente"}</strong><small>{sensor?.latestReadingAt && !sensor.latestReadingAt.startsWith("1970") ? `OCIO · ${formatHistoryDate(sensor.latestReadingAt)}` : "Esperando primera lectura OCIO"}</small></div>
        </div>
      </section>

      <section className="metrics-grid" aria-label="Indicadores del día">
        <Metric label="Litros despachados hoy" value={formatLiters(todayLiters)} delta="Registrados por el PLC" tone="blue" />
        <Metric label="Cargas completadas" value={String(today.filter((item) => item.status === "Completada").length)} delta={`${today.length} movimientos hoy`} tone="violet" />
        <Metric label="Promedio por carga" value={formatLiters(today.length ? todayLiters / today.length : 0)} delta="Calculado con las cargas de hoy" tone="sky" />
        <Metric label="Equipos habilitados" value={`${equipment.filter((item) => !item.archivedAt && item.active).length} / ${equipment.filter((item) => !item.archivedAt).length}`} delta="Registros vigentes" tone="ink" />
      </section>

      <section className="panel volume-panel">
        <div className="panel-heading"><div><span className="eyebrow">Últimos 7 días</span><h2>Volumen despachado</h2></div><strong>{formatCompactLiters(weeklyTotal)} <small>total semanal</small></strong></div>
        <div className="bar-chart" aria-label="Gráfico de volumen semanal">
          {weeklyValues.map((value, index) => <div className="bar-column" key={index}><div className="bar-track"><span style={{ height: `${value / weeklyMax * 100}%` }} /></div><small>{new Intl.DateTimeFormat("es-CL", { weekday: "short" }).format(new Date(nowMs - (6 - index) * 86400000)).replace(".", "")}</small></div>)}
        </div>
      </section>

      <section className="panel alerts-panel">
        <div className="panel-heading"><div><span className="eyebrow">Atención</span><h2>Alertas recientes</h2></div><button className="text-button" onClick={() => onNavigate("alerts")}>Ver todas →</button></div>
        <div className="compact-alerts">
          {alerts.slice(0, 3).map((alert) => <div key={alert.id} className={`compact-alert ${alert.severity}`}><span className="alert-symbol">{alert.severity === "warning" ? "!" : "i"}</span><div><strong>{alert.title}</strong><small>{alert.detail}</small></div><time>{alert.time.split(", ")[0]}</time></div>)}
        </div>
      </section>

      <section className="panel recent-panel">
        <div className="panel-heading"><div><span className="eyebrow">Trazabilidad</span><h2>Cargas recientes</h2></div><button className="text-button" onClick={() => onNavigate("transactions")}>Ver historial →</button></div>
        <TransactionTable items={transactions.slice(0, 4)} onOpen={onTransaction} compact />
      </section>
    </div>
  );
}

function Metric({ label, value, delta, tone }: { label: string; value: string; delta: string; tone: string }) {
  return <article className={`metric-card ${tone}`}><span className="metric-accent" /><p>{label}</p><strong>{value}</strong><small>{delta}</small></article>;
}

function SearchBar({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return <label className="search-bar"><span>⌕</span><input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} /></label>;
}

function Transactions({ search, status, items, allItems, onSearch, onStatus, onExport, onOpen }: { search: string; status: TransactionStatusFilter; items: Transaction[]; allItems: Transaction[]; onSearch: (value: string) => void; onStatus: (value: TransactionStatusFilter) => void; onExport: () => void; onOpen: (id: string) => void }) {
  const filters: { label: string; value: TransactionStatusFilter }[] = [
    { label: "Todas", value: "Todas" },
    { label: "Completadas", value: "Completada" },
    { label: "Excepcionales", value: "Excepcional" },
    { label: "Interrumpidas", value: "Interrumpida" },
  ];
  return (
    <div className="stack">
      <section className="filter-panel panel"><SearchBar value={search} onChange={onSearch} placeholder="Buscar por ID, operador o equipo" /><div className="filter-pills" aria-label="Filtrar cargas por estado">{filters.map((filter) => <button type="button" key={filter.value} className={status === filter.value ? "active" : ""} aria-pressed={status === filter.value} onClick={() => onStatus(filter.value)}>{filter.label}<span>{filter.value === "Todas" ? allItems.length : allItems.filter((item) => item.status === filter.value).length}</span></button>)}</div><button className="mobile-export secondary-button" onClick={onExport} disabled={items.length === 0}>↓ Exportar</button></section>
      <section className="panel table-panel"><div className="table-summary"><span><strong>{items.length}</strong> {items.length === 1 ? "carga encontrada" : "cargas encontradas"}</span><small>Datos conservados localmente por 1 año</small></div><TransactionTable items={items} onOpen={onOpen} emptyDetail={search || status !== "Todas" ? "Ajusta la búsqueda o selecciona otro estado." : "Todavía no existen cargas registradas."} /></section>
    </div>
  );
}

type HistoryScope = "week" | "month" | "year" | "custom";
type HistoryGranularity = "day" | "week" | "month" | "year";

function FuelHistoryView() {
  const initialRange = useMemo(() => historyRange("month"), []);
  const [scope, setScope] = useState<HistoryScope>("month");
  const [granularity, setGranularity] = useState<HistoryGranularity>("week");
  const [movementFilter, setMovementFilter] = useState<"all" | FuelMovement["type"]>("all");
  const [from, setFrom] = useState(initialRange.from);
  const [to, setTo] = useState(initialRange.to);
  const [data, setData] = useState<FuelHistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const ledgerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    let refreshing = false;
    let firstLoad = true;
    const refresh = () => {
      if (refreshing) return;
      refreshing = true;
      if (firstLoad) setLoading(true);
      setError("");
      fetch(`/api/fuel-history?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, {
        credentials: "same-origin", cache: "no-store", signal: controller.signal,
      }).then(async (response) => {
        const body = await response.json() as FuelHistoryResponse & { error?: string };
        if (!response.ok) throw new Error(body.error ?? "No fue posible consultar el histórico.");
        setData(body);
      }).catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(caught instanceof Error ? caught.message : "No fue posible consultar el histórico.");
      }).finally(() => {
        refreshing = false;
        if (!controller.signal.aborted) {
          setLoading(false);
          firstLoad = false;
        }
      });
    };
    const frame = window.requestAnimationFrame(refresh);
    const timer = window.setInterval(refresh, 5000);
    return () => { window.cancelAnimationFrame(frame); window.clearInterval(timer); controller.abort(); };
  }, [from, to]);

  const points = useMemo(() => aggregateFuelMovements(data?.movements ?? [], granularity), [data, granularity]);
  const shownMovements = useMemo(() => (data?.movements ?? []).filter((movement) => movementFilter === "all" || movement.type === movementFilter), [data, movementFilter]);
  const maxFlow = Math.max(1, ...points.flatMap((point) => [point.received, point.dispatched]));
  const axisMaximum = niceFuelAxisMaximum(maxFlow);
  const axisTicks = [1, .75, .5, .25, 0].map((ratio) => Math.round(axisMaximum * ratio));
  const applyScope = (next: HistoryScope) => {
    setScope(next);
    if (next === "custom") return;
    const range = historyRange(next);
    setFrom(range.from);
    setTo(range.to);
    setGranularity(next === "week" ? "day" : next === "month" ? "week" : "month");
  };
  const exportHistory = () => {
    if (!data) return;
    const header = "Fecha,Tipo,Litros,Nivel inicial,Nivel final,Origen,Referencia,Detección";
    const rows = data.movements.map((item) => [
      item.occurredAt, item.type === "receipt" ? "Recepción" : "Despacho", item.liters.toFixed(1),
      item.openingLevel.toFixed(1), item.closingLevel.toFixed(1), item.source, item.reference,
      item.detectedAutomatically ? "Automática" : "Trazable",
    ].map(csvCell).join(","));
    const url = URL.createObjectURL(new Blob([`\uFEFF${[header, ...rows].join("\n")}`], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `historico-combustible-${from}-${to}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };
  const receivedCount = data?.movements.filter((item) => item.type === "receipt").length ?? 0;
  const dispatchedCount = data?.movements.filter((item) => item.type === "dispatch").length ?? 0;
  const openLedger = (type: FuelMovement["type"]) => {
    setMovementFilter(type);
    window.requestAnimationFrame(() => ledgerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  return <div className="fuel-history-stack">
    <section className="panel history-controls" aria-label="Controles del histórico">
      <div className="history-scope">
        <span>Período</span>
        <div className="segmented-control">
          {([['week', 'Semana'], ['month', 'Mes'], ['year', 'Año'], ['custom', 'Personalizado']] as const).map(([value, label]) => <button type="button" key={value} className={scope === value ? "active" : ""} aria-pressed={scope === value} onClick={() => applyScope(value)}>{label}</button>)}
        </div>
      </div>
      <div className="history-date-range">
        <label>Desde<input type="date" value={from} max={to} onChange={(event) => { setScope("custom"); setFrom(event.target.value); }} /></label>
        <span aria-hidden="true">→</span>
        <label>Hasta<input type="date" value={to} min={from} onChange={(event) => { setScope("custom"); setTo(event.target.value); }} /></label>
      </div>
      <button className="secondary-button history-export" type="button" onClick={exportHistory} disabled={!data || data.movements.length === 0}>↓ Exportar CSV</button>
    </section>

    {error && <div className="auth-error" role="alert"><span>!</span>{error}</div>}
    <section className="history-kpis" aria-label="Resumen del período">
      <article className="history-kpi received"><span className="history-kpi-icon">↙</span><div><small>Combustible recibido</small><strong>{formatLiters(data?.summary.receivedLiters)}</strong><span>{receivedCount} {receivedCount === 1 ? "recepción" : "recepciones"}</span></div></article>
      <article className="history-kpi dispatched"><span className="history-kpi-icon">↗</span><div><small>Total despachado</small><strong>{formatLiters(data?.summary.dispatchedLiters)}</strong><span>{dispatchedCount} movimientos trazables</span></div></article>
      <article className="history-kpi balance"><span className="history-kpi-icon">±</span><div><small>Balance del período</small><strong>{data ? `${data.summary.netLiters >= 0 ? "+" : ""}${formatLiters(data.summary.netLiters)}` : "—"}</strong><span>Entradas menos despachos</span></div></article>
      <article className="history-kpi level"><div className="mini-tank"><span style={{ height: `${data ? Math.min(100, data.sensor.currentLevel / data.sensor.capacityLiters * 100) : 0}%` }} /></div><div><small>Nivel actual estimado</small><strong>{formatLiters(data?.sensor.currentLevel)}</strong><span>{data ? `${Math.round(data.sensor.currentLevel / data.sensor.capacityLiters * 100)}% de ${formatLiters(data.sensor.capacityLiters)}` : "Consultando sensor"}</span></div></article>
    </section>

    <section className="panel fuel-history-chart-panel">
      <div className="history-panel-head">
        <div><span className="eyebrow">Comportamiento del inventario</span><h2>Entradas y salidas</h2><p>Compara el combustible recibido con el despachado y sigue el nivel resultante del estanque.</p></div>
        <div className="chart-controls"><span>Agrupar por</span><div className="segmented-control compact">{([['day', 'Día'], ['week', 'Semana'], ['month', 'Mes'], ['year', 'Año']] as const).map(([value, label]) => <button type="button" key={value} className={granularity === value ? "active" : ""} aria-pressed={granularity === value} onClick={() => setGranularity(value)}>{label}</button>)}</div></div>
      </div>
      <div className="history-chart-legend"><span><i className="receipt" />Recepciones</span><span><i className="dispatch" />Despachos</span><span><i className="level" />Nivel del estanque</span></div>
      {loading ? <div className="history-loading" role="status">Reconstruyendo el histórico local…</div> : points.length === 0 ? <EmptyState title="Sin movimientos en este período" detail="Amplía el rango de fechas para revisar actividad anterior." /> : <div className="history-chart-scroll"><div className="fuel-history-chart" style={{ minWidth: `${Math.max(640, points.length * 82)}px` }}>
        <div className="chart-guides">{axisTicks.map((tick) => <span key={tick} />)}</div>
        <div className="fuel-chart-axis" aria-label="Escala vertical en litros">{axisTicks.map((tick) => <span key={tick}>{tick.toLocaleString("es-CL")} L</span>)}</div>
        {points.map((point) => <div className="fuel-chart-column" key={point.key} title={`${point.label}: ${formatLiters(point.received)} recibidos y ${formatLiters(point.dispatched)} despachados`}>
          <div className="fuel-bars"><button type="button" className="received-bar" disabled={!point.received} aria-label={`Ver recepciones de ${point.label}: ${formatLiters(point.received)}`} onClick={() => openLedger("receipt")} style={{ height: `${point.received ? Math.max(5, point.received / axisMaximum * 100) : 0}%` }} /><button type="button" className="dispatched-bar" disabled={!point.dispatched} aria-label={`Ver despachos de ${point.label}: ${formatLiters(point.dispatched)}`} onClick={() => openLedger("dispatch")} style={{ height: `${point.dispatched ? Math.max(5, point.dispatched / axisMaximum * 100) : 0}%` }} /><i className="inventory-level-dot" style={{ bottom: `${Math.min(96, Math.max(2, point.closingLevel / (data?.sensor.capacityLiters ?? 2500) * 100))}%` }} /></div>
          <strong>{point.label}</strong><small>{formatCompactLiters(point.received + point.dispatched)}</small>
        </div>)}
      </div></div>}
    </section>

    <section className="panel fuel-ledger" id="fuel-ledger" ref={ledgerRef}>
      <div className="history-panel-head ledger-head">
        <div><span className="eyebrow">Registro auditable</span><h2>Movimientos del período</h2><p>Cada recepción y despacho conserva su origen, referencia y nivel antes y después.</p></div>
        <div className="movement-filters" aria-label="Filtrar movimientos">
          <button className={movementFilter === "all" ? "active" : ""} aria-pressed={movementFilter === "all"} onClick={() => setMovementFilter("all")}>Todos <span>{data?.movements.length ?? 0}</span></button>
          <button className={movementFilter === "receipt" ? "active" : ""} aria-pressed={movementFilter === "receipt"} onClick={() => setMovementFilter("receipt")}>Recepciones <span>{receivedCount}</span></button>
          <button className={movementFilter === "dispatch" ? "active" : ""} aria-pressed={movementFilter === "dispatch"} onClick={() => setMovementFilter("dispatch")}>Despachos <span>{dispatchedCount}</span></button>
        </div>
      </div>
      <div className="fuel-ledger-columns" aria-hidden="true"><span>Movimiento</span><span>Volumen</span><span>Nivel del estanque</span><span>Origen y referencia</span></div>
      <div className="fuel-ledger-list">{shownMovements.map((item) => <article className={`fuel-ledger-row ${item.type}`} key={item.id}>
        <div className="movement-main"><span className="movement-icon">{item.type === "receipt" ? "↙" : "↗"}</span><div><strong>{item.type === "receipt" ? "Recepción de combustible" : "Despacho de combustible"}</strong><time>{formatHistoryDate(item.occurredAt)}</time>{item.detectedAutomatically && <span className="automatic-tag">Detección automática · {Math.round(item.confidence * 100)}%</span>}</div></div>
        <strong className="movement-liters">{item.type === "receipt" ? "+" : "−"}{formatLiters(item.liters)}</strong>
        <div className="level-transition"><span>{formatCompactLiters(item.openingLevel)}</span><i>→</i><strong>{formatCompactLiters(item.closingLevel)}</strong></div>
        <div className="movement-source"><strong>{item.source}</strong><span>{item.reference}</span><small>{item.detail}</small></div>
      </article>)}</div>
      {!loading && shownMovements.length === 0 && <EmptyState title="No hay movimientos para este filtro" detail="Selecciona otro tipo de movimiento o amplía el período." />}
    </section>
  </div>;
}

function historyRange(scope: Exclude<HistoryScope, "custom">) {
  const end = new Date();
  const start = new Date(end);
  if (scope === "week") start.setDate(end.getDate() - 6);
  if (scope === "month") start.setDate(end.getDate() - 29);
  if (scope === "year") { start.setMonth(0, 1); }
  return { from: dateInputValue(start), to: dateInputValue(end) };
}

function aggregateFuelMovements(movements: FuelMovement[], granularity: HistoryGranularity) {
  const buckets = new Map<string, { key: string; label: string; received: number; dispatched: number; closingLevel: number; lastAt: string }>();
  [...movements].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)).forEach((movement) => {
    const date = new Date(movement.occurredAt);
    const bucketDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    if (granularity === "week") bucketDate.setUTCDate(bucketDate.getUTCDate() - ((bucketDate.getUTCDay() + 6) % 7));
    if (granularity === "month") bucketDate.setUTCDate(1);
    if (granularity === "year") bucketDate.setUTCMonth(0, 1);
    const key = granularity === "day" || granularity === "week" ? bucketDate.toISOString().slice(0, 10) : granularity === "month" ? bucketDate.toISOString().slice(0, 7) : String(bucketDate.getUTCFullYear());
    const label = granularity === "day" ? new Intl.DateTimeFormat("es-CL", { day: "2-digit", month: "short", timeZone: "UTC" }).format(bucketDate)
      : granularity === "week" ? `Sem ${new Intl.DateTimeFormat("es-CL", { day: "2-digit", month: "short", timeZone: "UTC" }).format(bucketDate)}`
      : granularity === "month" ? new Intl.DateTimeFormat("es-CL", { month: "short", year: "2-digit", timeZone: "UTC" }).format(bucketDate)
      : String(bucketDate.getUTCFullYear());
    const current = buckets.get(key) ?? { key, label, received: 0, dispatched: 0, closingLevel: movement.closingLevel, lastAt: movement.occurredAt };
    if (movement.type === "receipt") current.received += movement.liters;
    else current.dispatched += movement.liters;
    if (movement.occurredAt >= current.lastAt) { current.closingLevel = movement.closingLevel; current.lastAt = movement.occurredAt; }
    buckets.set(key, current);
  });
  return [...buckets.values()].map((point) => ({ ...point, received: Math.round(point.received * 10) / 10, dispatched: Math.round(point.dispatched * 10) / 10 }));
}

function niceFuelAxisMaximum(value: number) {
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(1, value)));
  const normalized = value / magnitude;
  const rounded = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return rounded * magnitude;
}

function dateInputValue(date: Date) {
  const year = date.getFullYear();
  return `${year}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function formatLiters(value?: number) {
  if (value == null) return "—";
  const decimals = value !== 0 && Math.abs(value) < 1 ? 2 : 1;
  return `${value.toLocaleString("es-CL", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })} L`;
}
function formatCompactLiters(value: number) { return `${Math.round(value).toLocaleString("es-CL")} L`; }
function formatHistoryDate(value: string) { return new Intl.DateTimeFormat("es-CL", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
function formatAlertDate(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("es-CL", { dateStyle: "medium", timeStyle: "short" }).format(date); }
function movementToTransaction(item: FuelMovement): Transaction {
  const parts = item.detail.split(" · ").map((part) => part.trim()).filter(Boolean);
  const unauthorized = /no autorizado|bypass/u.test(`${item.detail} ${item.source}`.toLocaleLowerCase("es-CL"));
  const exceptional = unauthorized || item.isMaster === true || (parts[1]?.toLocaleLowerCase("es-CL").includes("excepcional") ?? false);
  const closeReason = parts.find((part) => part.startsWith("Cierre:"))?.slice(7).trim() ?? "";
  const interrupted = /ble|fault|falla|timeout|persistence/u.test(closeReason.toLowerCase());
  const detailOperator = parts[0] && parts[0] !== item.operatorId ? parts[0] : "";
  const detailEquipment = parts[1] && parts[1] !== item.equipmentId ? parts[1] : "";
  return {
    id: item.reference || item.id,
    occurredAt: item.occurredAt,
    time: formatHistoryDate(item.occurredAt),
    operator: unauthorized ? "Sin operador autorizado" : item.operatorName || detailOperator || "Operador no disponible",
    equipment: unauthorized ? "Sin equipo autorizado" : exceptional ? "Carga de emergencia sin equipo validado" : item.equipmentName || detailEquipment || "Equipo no disponible",
    liters: item.liters,
    duration: "—",
    status: exceptional ? "Excepcional" : interrupted ? "Interrumpida" : "Completada",
    validation: unauthorized ? "K24 · bypass detectado" : exceptional ? "Credencial maestra" : interrupted ? "Cierre de seguridad" : "NFC + BLE",
    source: item.source,
  };
}
function csvCell(value: unknown) { return `"${String(value).replaceAll('"', '""')}"`; }

function TransactionTable({ items, onOpen, compact = false, emptyDetail = "Prueba con otro término de búsqueda." }: { items: Transaction[]; onOpen: (id: string) => void; compact?: boolean; emptyDetail?: string }) {
  return (
    <div className="data-table-wrap">
      <table className="data-table">
        <thead><tr><th>Transacción</th><th>Operador / equipo</th><th>Litros</th>{!compact && <th>Duración</th>}<th>Estado</th><th><span className="sr-only">Acción</span></th></tr></thead>
        <tbody>{items.map((item) => <tr key={item.id}>
          <td><strong>{item.id}</strong><small>{item.time}</small></td>
          <td><strong>{item.operator}</strong><small>{item.equipment}</small></td>
          <td className="liters"><strong>{item.liters.toLocaleString("es-CL", { minimumFractionDigits: 1 })} L</strong><small>{item.validation}</small></td>
          {!compact && <td>{item.duration}</td>}
          <td><StatusBadge status={item.status} /></td>
          <td><button className="row-action" aria-label={`Ver ${item.id}`} onClick={() => onOpen(item.id)}>→</button></td>
        </tr>)}</tbody>
      </table>
      {items.length === 0 && <EmptyState title="No encontramos cargas" detail={emptyDetail} />}
    </div>
  );
}

function StatusBadge({ status }: { status: Transaction["status"] }) {
  return <span className={`status-badge ${status.toLowerCase()}`}><i />{status}</span>;
}

function Operators({ operators, search, isProviderAdmin, onSearch, onToggle, onArchive, onDelete, onReplace, onCredentials }: { operators: Operator[]; search: string; isProviderAdmin: boolean; onSearch: (value: string) => void; onToggle: (item: Operator) => void; onArchive: (item: Operator, archived: boolean) => void; onDelete: (item: Operator) => void; onReplace: (item: Operator) => void; onCredentials: () => void }) {
  const [scope, setScope] = useState<"current" | "archived">("current");
  const scoped = operators.filter((item) => scope === "archived" ? Boolean(item.archivedAt) : !item.archivedAt);
  const filtered = scoped.filter((item) => `${item.name} ${item.rut} ${item.credential}`.toLowerCase().includes(search.toLowerCase()));
  return <div className="stack"><section className="filter-panel panel"><SearchBar value={search} onChange={onSearch} placeholder="Buscar operador, RUT o credencial" /><HistorySelect label="Operadores" scope={scope} archivedCount={operators.filter((item) => item.archivedAt).length} onChange={setScope} /><div className="summary-chips"><span><strong>{operators.filter((item) => !item.archivedAt && item.active).length}</strong> activos</span><span><strong>{operators.filter((item) => !item.archivedAt && item.credentialIsMaster && item.credentialActive).length}</strong> tarjeta maestra</span></div></section>{filtered.length > 0 ? <section className="entity-grid">{filtered.map((item) => <article className={`entity-card panel ${item.archivedAt ? "archived" : ""}`} key={item.id}><div className="entity-head"><span className="large-avatar">{initials(item.name)}</span><div><h3>{item.name}</h3><p>{item.rut}</p></div>{!item.archivedAt && <button className={`switch ${item.active ? "on" : ""}`} aria-label={`${item.active ? "Desactivar" : "Activar"} a ${item.name}`} onClick={() => onToggle(item)}><span /></button>}</div><div className="entity-details"><span><small>{item.credentialIsMaster ? "Tarjeta maestra" : "Credencial"}</small><strong>{item.credential}</strong></span><span><small>{item.archivedAt ? "Archivado" : "Último uso"}</small><strong>{item.archivedAt ? formatArchivedDate(item.archivedAt) : item.lastUse}</strong></span></div><div className="entity-footer"><span className={item.archivedAt || !item.active || !item.credentialActive ? "muted-text" : item.credentialIsMaster ? "master-credential-state" : "active-text"}><i />{item.archivedAt ? "Histórico" : !item.credentialActive ? "Credencial desactivada" : item.credentialIsMaster ? "Maestra de emergencia" : item.active ? "Habilitado" : "Desactivado"}</span><div className="entity-actions">{item.archivedAt ? <><button className="text-button" onClick={() => onArchive(item, false)}>Restaurar</button>{isProviderAdmin && <button className="text-button danger-text" onClick={() => onDelete(item)}>Eliminar definitivamente</button>}</> : <>{item.credential === "Sin enrolar" || !isProviderAdmin ? <button className="text-button" onClick={onCredentials}>{item.credential === "Sin enrolar" ? "Asignar RFID" : "Ver RFID"}</button> : <button className="text-button" onClick={() => onReplace(item)}>Reemplazar NFC</button>}<button className="text-button archive-text" onClick={() => onArchive(item, true)}>Archivar</button></>}</div></div></article>)}</section> : <section className="panel"><EmptyState title={scope === "archived" ? "Sin operadores pasados" : "No encontramos operadores"} detail={scope === "archived" ? "Los operadores archivados aparecerán aquí sin afectar la operación diaria." : "Prueba con otro nombre, RUT o credencial."} /></section>}</div>;
}

function RfidCredentialsView({ credentials, operators, isProviderAdmin, onIdentify, onCreate, onAssign, onUnassign, onDelete }: { credentials: RfidCredential[]; operators: Operator[]; isProviderAdmin: boolean; onIdentify: () => void; onCreate: () => void; onAssign: (credentialId?: string) => void; onUnassign: (credentialId: string) => void; onDelete: (credentialId: string) => void }) {
  const [section, setSection] = useState<"inventory" | "assignments">("inventory");
  const [query, setQuery] = useState("");
  const assigned = credentials.filter((item) => item.operatorId);
  const filtered = credentials.filter((item) => `${item.credentialId} ${item.operatorName ?? ""}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="stack rfid-credentials-page">
    <section className="rfid-overview panel"><div className="rfid-overview-copy"><span className="rfid-overview-mark">⌁</span><div><span className="eyebrow">INVENTARIO LOCAL SINCRONIZADO</span><h2>{credentials.length} {credentials.length === 1 ? "credencial RFID" : "credenciales RFID"}</h2><p>{isProviderAdmin ? "Los cambios se replican en la Raspberry para mantener la autorización offline." : "Consulta y vincula credenciales existentes. Los tags nuevos los enrola el proveedor tecnológico."}</p></div></div><div className="summary-chips"><span><strong>{assigned.length}</strong> asignadas</span><span><strong>{credentials.filter((item) => item.credentialIsMaster && item.credentialActive).length}</strong> maestra</span></div><button className="secondary-button compact" type="button" onClick={onIdentify}>⌁ Identificar credencial RFID</button></section>
    <section className="rfid-section-tabs panel"><div className="segmented-control"><button className={section === "inventory" ? "active" : ""} type="button" onClick={() => setSection("inventory")}>Credenciales</button><button className={section === "assignments" ? "active" : ""} type="button" onClick={() => setSection("assignments")}>Vinculaciones</button></div>{section === "inventory" ? <SearchBar value={query} onChange={setQuery} placeholder="Buscar tag u operador" /> : <button className="primary-button compact" type="button" onClick={() => onAssign()}>＋ Nueva vinculación</button>}</section>
    {section === "inventory" ? (filtered.length ? <section className="rfid-inventory panel"><div className="rfid-list-head"><span>Credencial</span><span>Tipo</span><span>Operador</span><span>Estado</span><span /></div>{filtered.map((item) => <article className="rfid-list-row" key={item.credentialId}><div className="rfid-identity"><span className={`rfid-mini ${item.credentialIsMaster ? "master" : ""}`}>⌁</span><div><strong>{item.credentialId}</strong><small>Enrolada {formatCompactDate(item.createdAt)}</small></div></div><span className={`rfid-kind ${item.credentialIsMaster ? "master" : ""}`}>{item.credentialIsMaster ? "Maestra" : "Normal"}</span><div className="rfid-owner"><strong>{item.operatorName ?? "Sin asignar"}</strong><small>{item.operatorRut ?? "Disponible para vincular"}</small></div><span className={item.credentialActive ? item.operatorId ? "active-text" : "rfid-available" : "muted-text"}><i />{item.credentialActive ? item.operatorId ? "Operativa" : "Disponible" : "Inactiva"}</span><div className="rfid-row-actions"><button className="text-button" type="button" onClick={() => onAssign(item.credentialId)}>{item.operatorId ? "Cambiar" : "Asignar"}</button>{isProviderAdmin && <button className="text-button danger-text" type="button" onClick={() => onDelete(item.credentialId)}>Eliminar</button>}</div></article>)}</section> : <section className="panel"><EmptyState title="Sin credenciales RFID" detail={isProviderAdmin ? "Enrola el primer tag para incorporarlo al inventario local." : "El administrador del proveedor tecnológico debe enrolar el primer tag."} />{isProviderAdmin && <div className="empty-action"><button className="primary-button" type="button" onClick={onCreate}>＋ Enrolar credencial</button></div>}</section>) : (assigned.length ? <section className="association-list rfid-association-list">{assigned.map((item) => <article className="association-row panel" key={item.credentialId}><div className="association-person rfid-association-tag"><span className={`rfid-mini ${item.credentialIsMaster ? "master" : ""}`}>⌁</span><div><small>CREDENCIAL RFID</small><strong>{item.credentialId}</strong><span>{item.credentialIsMaster ? "Tarjeta maestra" : "Credencial normal"}</span></div></div><div className="association-link"><span /><b>↔</b><span /></div><div className="association-equipment rfid-association-operator"><span className="large-avatar small">{initials(item.operatorName ?? "")}</span><div><small>OPERADOR</small><strong>{item.operatorName}</strong><span>{item.operatorRut}</span></div></div><div className="association-state"><span className={item.credentialActive && item.operatorActive && !item.operatorArchivedAt ? "active-text" : "muted-text"}><i />{item.credentialActive && item.operatorActive && !item.operatorArchivedAt ? "Vigente" : "Sin autorización"}</span><small>Máximo una credencial por operador</small></div><div className="association-actions"><button className="text-button" type="button" onClick={() => onAssign(item.credentialId)}>Cambiar</button>{!item.credentialIsMaster && <button className="text-button archive-text" type="button" onClick={() => onUnassign(item.credentialId)}>Desvincular</button>}</div></article>)}</section> : <section className="panel"><EmptyState title="Sin vinculaciones RFID" detail={`Hay ${operators.filter((item) => !item.archivedAt && item.active).length} operadores vigentes disponibles para asociar.`} /><div className="empty-action"><button className="primary-button" type="button" onClick={() => onAssign()}>＋ Nueva vinculación</button></div></section>)}
  </div>;
}

function EquipmentView({ equipment, candidates, scan, search, nowMs, isProviderAdmin, onSearch, onToggle, onArchive, onDelete, onOpen, onEnroll, onRefresh }: { equipment: Equipment[]; candidates: EnrollmentCandidate[]; scan: EquipmentScan | null; search: string; nowMs: number; isProviderAdmin: boolean; onSearch: (value: string) => void; onToggle: (item: Equipment) => void; onArchive: (item: Equipment, archived: boolean) => void; onDelete: (item: Equipment) => void; onOpen: (id: string) => void; onEnroll: (moduleId: string) => void; onRefresh: () => void }) {
  const [scope, setScope] = useState<"current" | "archived">("current");
  const scoped = equipment.filter((item) => scope === "archived" ? Boolean(item.archivedAt) : !item.archivedAt);
  const filtered = scoped.filter((item) => `${item.name} ${item.kind} ${item.module}`.toLowerCase().includes(search.toLowerCase()));
  const pendingCandidates = candidates.filter((candidate) => candidate.status !== "enrolled");
  void scan;
  return <div className="stack">
    <section className="panel bluetooth-enrollment">
      <div className="enrollment-copy"><span className="bluetooth-mark">W</span><div><span className="eyebrow">ENROLAMIENTO MIM POR WI-FI · ACTUALIZACIÓN CADA 5 S</span><h2>Energiza el Módulo Identificador de Máquina (MIM)</h2><p>Un MIM nuevo se conecta automáticamente a la red local de la Raspberry, autentica su identidad y queda disponible para asignarlo al fundo.</p><button className="secondary-button scan-refresh-button" type="button" onClick={onRefresh}><span className="scan-refresh-icon"><RefreshArrow /></span>Actualizar lectura de MIMs</button></div></div>
      <div className="candidate-list" aria-live="polite">
        {pendingCandidates.length === 0 && <div className="candidate-scanning"><span className="scan-rings" /><div><strong>Esperando un MIM nuevo…</strong><small>Energízalo. Se conectará solo a la red Wi-Fi privada de la Raspberry; no necesitas presionar botones ni configurar el teléfono.</small></div></div>}
        {pendingCandidates.map((candidate) => {
          const connected = mimSignalIsFresh(candidate, nowMs);
          return <article className={`candidate-row ${candidate.status} ${connected ? "connected" : "stale"}`} key={candidate.moduleId}>
          <div><strong>{candidate.requestedName ?? candidate.deviceName ?? (candidate.claimed ? "MIM disponible para reasignar" : "Módulo Identificador de Máquina (MIM) detectado")}</strong><small>{candidate.moduleId} · fundo actual {candidate.siteId}</small></div>
          <span className={`candidate-signal ${!connected ? "stale" : candidate.rssi > -65 ? "strong" : candidate.rssi <= -80 ? "weak" : ""}`}><i />{connected ? `${candidate.rssi} dBm Wi-Fi` : "Sin reporte reciente"}<small>{candidate.rssi <= -80 ? "señal débil" : "enlace local"} · {formatMimSignalAge(candidate.lastSeen, nowMs)}</small></span>
          {candidate.status === "detected" && <button className="primary-button compact" onClick={() => onEnroll(candidate.moduleId)}>{candidate.claimed ? "Asignar a este fundo" : "Nombrar y enrolar"}</button>}
          {candidate.status === "pending" && <span className="enrollment-state">Esperando enlace…</span>}
          {candidate.status === "enrolling" && <span className="enrollment-state working">Configurando…</span>}
          {candidate.status === "failed" && <><span className="enrollment-state failed">{candidate.error ?? "No se pudo enlazar"}</span><button className="secondary-button compact" onClick={() => onEnroll(candidate.moduleId)}>Reintentar</button></>}
        </article>;})}
      </div>
    </section>
    <section className="filter-panel panel"><SearchBar value={search} onChange={onSearch} placeholder="Buscar equipo, tipo o módulo" /><HistorySelect label="Equipos" scope={scope} archivedCount={equipment.filter((item) => item.archivedAt).length} onChange={setScope} /><div className="summary-chips"><span><strong>{equipment.filter((item) => !item.archivedAt && item.active && !item.assignmentExpired).length}</strong> habilitados</span><span><strong>{equipment.filter((item) => !item.archivedAt && item.assignmentExpired).length}</strong> vencidos</span></div></section>
    {filtered.length > 0 ? <section className="entity-grid equipment-grid">{filtered.map((item) => {
      const expired = Boolean(item.assignmentExpired);
      const candidate = candidates.find((entry) => entry.moduleId === item.module && ["detected", "failed"].includes(entry.status));
      const signal = candidates.find((entry) => entry.moduleId === item.module);
      const connected = Boolean(signal && mimSignalIsFresh(signal, nowMs));
      return <article className={`entity-card panel ${item.archivedAt ? "archived" : ""} ${expired ? "assignment-expired" : ""}`} key={item.id}>
        <div className="entity-head"><span className="equipment-icon">{item.kind.slice(0, 2).toUpperCase()}</span><div><span className={`condition ${expired ? "expired" : item.condition.toLowerCase()}`}>{expired ? "Vencido" : item.condition}</span><h3>{item.name}</h3><p>{item.kind}</p></div>{!item.archivedAt && !expired && <button className={`switch ${item.active ? "on" : ""}`} aria-label={`${item.active ? "Desactivar" : "Activar"} ${item.name}`} onClick={() => onToggle(item)}><span /></button>}</div>
        <div className="module-row"><div><small>Módulo · fundo</small><strong>{item.module}</strong><small>{item.siteId || "Sin fundo asignado"}</small></div><div className="module-telemetry">{signal && <div className={`live-signal ${connected ? "" : "offline"}`} title={`Última señal recibida ${formatMimSignalAge(signal.lastSeen, nowMs)}`}><i /><span><strong>{connected ? `${signal.rssi} dBm` : "Sin señal reciente"}</strong><small>{connected ? "Actualiza cada 5 s" : formatMimSignalAge(signal.lastSeen, nowMs)}</small></span></div>}</div></div>
        {item.expiry && <div className={`expiry-note ${expired ? "expired" : item.assignmentExpiringSoon ? "expiring" : ""}`}><span>◷</span>{expired ? "Venció el " : item.assignmentExpiringSoon ? "Vence en menos de 24 h · " : "Vigente hasta el "}{formatAssignmentDate(item.expiry)}</div>}
        <div className="entity-footer"><span className={item.archivedAt || !item.active || expired ? "muted-text" : "active-text"}><i />{item.archivedAt ? "Histórico" : expired ? "Carga bloqueada por vencimiento" : item.active ? "Disponible para carga" : "Fuera de servicio"}</span><div className="entity-actions">{item.archivedAt ? <><button className="text-button" onClick={() => onArchive(item, false)}>Restaurar</button>{isProviderAdmin && <button className="text-button danger-text" onClick={() => onDelete(item)}>Eliminar definitivamente</button>}</> : <><button className="text-button" onClick={() => onOpen(item.id)}>Ver ficha</button>{expired && candidate && <button className="text-button revalidate-text" onClick={() => onEnroll(candidate.moduleId)}>Revalidar módulo</button>}{expired && !candidate && <span className="revalidate-hint">Energiza para revalidar</span>}<button className="text-button archive-text" onClick={() => onArchive(item, true)}>Archivar</button></>}</div></div>
      </article>;
    })}</section> : <section className="panel"><EmptyState title={scope === "archived" ? "Sin equipos pasados" : "Aún no hay equipos enrolados"} detail={scope === "archived" ? "Los equipos archivados aparecerán aquí sin afectar la operación diaria." : "Energiza un Módulo Identificador de Máquina (MIM) y aparecerá arriba automáticamente."} /></section>}
  </div>;
}

function AssociationsView({ associations, operators, equipment, isProviderAdmin, onToggle, onArchive, onDelete }: { associations: Association[]; operators: Operator[]; equipment: Equipment[]; isProviderAdmin: boolean; onToggle: (item: Association) => void; onArchive: (item: Association, archived: boolean) => void; onDelete: (item: Association, name: string) => void }) {
  const [scope, setScope] = useState<"current" | "archived">("current");
  const visible = associations.filter((item) => scope === "archived" ? Boolean(item.archivedAt) : !item.archivedAt);
  return <div className="stack"><section className="association-summary panel"><div><span className="summary-number">{associations.filter((item) => !item.archivedAt && item.active).length}</span><span>asociaciones<br />vigentes</span></div><p>Una carga normal sólo se autoriza cuando la relación operador–equipo está activa y ambos registros son válidos.</p><HistorySelect label="Asociaciones" scope={scope} archivedCount={associations.filter((item) => item.archivedAt).length} onChange={setScope} /></section>{visible.length > 0 ? <section className="association-list">{visible.map((item) => { const operator = operators.find((entry) => entry.id === item.operatorId); const asset = equipment.find((entry) => entry.id === item.equipmentId); const label = `${operator?.name ?? "Operador"} · ${asset?.name ?? "Equipo"}`; return <article className={`association-row panel ${!item.active || item.archivedAt ? "disabled" : ""}`} key={item.id}><div className="association-person"><span className="large-avatar small">{initials(operator?.name ?? "")}</span><div><small>OPERADOR</small><strong>{operator?.name ?? "Registro no disponible"}</strong><span>{operator?.credential}</span></div></div><div className="association-link"><span /><b>↔</b><span /></div><div className="association-equipment"><span className="equipment-icon small">{asset?.kind.slice(0, 2).toUpperCase()}</span><div><small>EQUIPO</small><strong>{asset?.name ?? "Registro no disponible"}</strong><span>{asset?.module}</span></div></div><div className="association-state"><span className={item.active && !item.archivedAt ? "active-text" : "muted-text"}><i />{item.archivedAt ? "Histórica" : item.active ? "Vigente" : "Suspendida"}</span><small>{item.archivedAt ? `Archivada ${formatArchivedDate(item.archivedAt)}` : `Desde ${item.since}`}</small></div><div className="association-actions">{item.archivedAt ? <><button className="text-button" onClick={() => onArchive(item, false)}>Restaurar</button>{isProviderAdmin && <button className="text-button danger-text" onClick={() => onDelete(item, label)}>Eliminar definitivamente</button>}</> : <><button className={`switch ${item.active ? "on" : ""}`} aria-label="Cambiar estado de asociación" onClick={() => onToggle(item)}><span /></button><button className="text-button archive-text" onClick={() => onArchive(item, true)}>Archivar</button></>}</div></article>; })}</section> : <section className="panel"><EmptyState title={scope === "archived" ? "Sin asociaciones pasadas" : "Sin asociaciones actuales"} detail={scope === "archived" ? "Las asociaciones archivadas aparecerán aquí para consulta y auditoría." : "Crea una asociación para autorizar un operador y un equipo."} /></section>}</div>;
}

function HistorySelect({ label, scope, archivedCount, onChange }: { label: string; scope: "current" | "archived"; archivedCount: number; onChange: (scope: "current" | "archived") => void }) {
  const past = label === "Asociaciones" ? "pasadas" : "pasados";
  return <label className="history-select"><span>Mostrar</span><select value={scope} onChange={(event) => onChange(event.target.value as "current" | "archived")}><option value="current">{label} actuales</option><option value="archived">{label} {past} ({archivedCount})</option></select></label>;
}

const alertPriorities: AlertPriority[] = ["urgent", "high", "medium", "low"];
const alertPriorityCopy: Record<AlertPriority, string> = { urgent: "Urgente", high: "Alta", medium: "Media", low: "Baja" };
const alertStatusCopy: Record<AlertStatus, string> = { pending: "Pendiente", in_progress: "Tomando acción", resolved: "Resuelta" };

function AlertsView({ alerts, canManage, onOpen }: { alerts: AlertItem[]; canManage: boolean; onOpen: (id: string) => void }) {
  const [priorityFilter, setPriorityFilter] = useState<AlertPriority | "all">("all");
  const [statusFilter, setStatusFilter] = useState<AlertStatus | "active" | "all">("active");
  const [sort, setSort] = useState<"priority" | "recent">("priority");
  const activeAlerts = alerts.filter((item) => item.status !== "resolved");
  const priorityCounts = Object.fromEntries(alertPriorities.map((priority) => [priority, activeAlerts.filter((item) => item.priority === priority).length])) as Record<AlertPriority, number>;
  const priorityRank: Record<AlertPriority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
  const visible = alerts.filter((item) => {
    const priorityMatches = priorityFilter === "all" || item.priority === priorityFilter;
    const statusMatches = statusFilter === "all" || (statusFilter === "active" ? item.status !== "resolved" : item.status === statusFilter);
    return priorityMatches && statusMatches;
  }).sort((left, right) => sort === "priority"
    ? priorityRank[left.priority] - priorityRank[right.priority] || new Date(right.time).getTime() - new Date(left.time).getTime()
    : new Date(right.time).getTime() - new Date(left.time).getTime());
  const inProgress = alerts.filter((item) => item.status === "in_progress").length;
  return <div className="alerts-workspace">
    <section className="panel alert-priority-dashboard">
      <div className="alert-dashboard-heading"><div><span className="eyebrow">Criticidad activa</span><h2>Prioridades de atención</h2></div><span><strong>{activeAlerts.length}</strong> alertas abiertas</span></div>
      <div className="priority-counter-grid">{alertPriorities.map((priority) => <button type="button" className={`priority-counter ${priority} ${priorityFilter === priority ? "active" : ""}`} aria-pressed={priorityFilter === priority} onClick={() => setPriorityFilter(priorityFilter === priority ? "all" : priority)} key={priority}><i /><span>{alertPriorityCopy[priority]}</span><strong>{priorityCounts[priority]}</strong><small>{priority === "urgent" ? "Atención inmediata" : priority === "high" ? "Resolver pronto" : priority === "medium" ? "Seguimiento normal" : "Puede programarse"}</small></button>)}</div>
    </section>
    <div className="alerts-layout">
      <section className="alert-feed panel">
        <div className="alert-feed-head"><div><strong>{visible.length}</strong><span>resultados · {inProgress} tomando acción</span></div><div className="alert-feed-controls"><label>Estado<select aria-label="Filtrar alertas por estado" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}><option value="active">Abiertas</option><option value="all">Todas</option><option value="pending">Pendientes</option><option value="in_progress">Tomando acción</option><option value="resolved">Resueltas</option></select></label><label>Orden<select aria-label="Ordenar alertas" value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}><option value="priority">Prioridad</option><option value="recent">Más recientes</option></select></label></div></div>
        {visible.map((item) => <article className={`alert-row priority-${item.priority} ${item.status === "resolved" ? "acknowledged" : ""}`} key={item.id}><span className="alert-priority-mark" aria-hidden="true">{item.priority === "urgent" ? "!" : item.priority === "high" ? "↑" : item.priority === "medium" ? "•" : "↓"}</span><div><div className="alert-title-row"><strong>{item.title}</strong><span className={`priority-badge ${item.priority}`}>{alertPriorityCopy[item.priority]}</span><span className={`alert-status-badge ${item.status}`}>{alertStatusCopy[item.status]}</span></div><p>{item.detail}</p><div className="alert-row-meta"><time>{formatAlertDate(item.time)}</time>{canManage && <span>{item.comments?.length ?? 0} {(item.comments?.length ?? 0) === 1 ? "comentario" : "comentarios"}</span>}</div></div><button className="secondary-button small" onClick={() => onOpen(item.id)}>Abrir alerta</button></article>)}
        {visible.length === 0 && <EmptyState title={alerts.length === 0 ? "Sin alertas registradas" : "Sin alertas para estos filtros"} detail={alerts.length === 0 ? "Las fallas y advertencias del controlador edge aparecerán aquí." : "Cambia el estado o selecciona otra prioridad."} />}
      </section>
      <aside className="panel alert-guide"><span className="eyebrow">Flujo de atención</span><h2>Seguimiento sin perder contexto</h2><p>Una alerta puede permanecer abierta mientras el encargado investiga o ejecuta una medida.</p><div className="status-mini-dashboard"><div><i className="pending" /><span><strong>{alerts.filter((item) => item.status === "pending").length}</strong>Pendientes</span></div><div><i className="in-progress" /><span><strong>{inProgress}</strong>Tomando acción</span></div><div><i className="resolved" /><span><strong>{alerts.filter((item) => item.status === "resolved").length}</strong>Resueltas</span></div></div><ol><li>Abre la alerta y define su criticidad.</li><li>Guarda comentarios mientras se trabaja.</li><li>Selecciona “Resuelta” sólo al terminar.</li></ol><small>{canManage ? "El historial completo es visible para administración y encargados autorizados." : "Tu perfil puede consultar alertas; el historial de atención está restringido."}</small></aside>
    </div>
  </div>;
}

const permissionCopy: Record<Permission, string> = {
  view_dashboard: "Ver resumen operacional",
  view_transactions: "Consultar y exportar cargas",
  manage_alerts: "Atender y cerrar alertas",
  manage_operators: "Gestionar operadores NFC",
  manage_equipment: "Gestionar equipos",
  manage_associations: "Gestionar asociaciones",
  manage_users: "Administrar usuarios y permisos",
  manage_system: "Administrar sistema y respaldos",
};
const roleCopy: Record<UserRole, string> = { master: "Usuario maestro", administrator: "Administrador", supervisor: "Supervisor operacional", viewer: "Consulta" };
const rolePreset: Record<Exclude<UserRole, "master">, Permission[]> = {
  administrator: Object.keys(permissionCopy) as Permission[],
  supervisor: ["view_dashboard", "view_transactions", "manage_alerts", "manage_operators", "manage_equipment", "manage_associations"],
  viewer: ["view_dashboard", "view_transactions"],
};

function AccessView({ canDeleteUsers }: { canDeleteUsers: boolean }) {
  const [users, setUsers] = useState<WebUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<WebUser | "new" | null>(null);
  const [temporary, setTemporary] = useState<{ name: string; password: string } | null>(null);
  const [deleting, setDeleting] = useState<WebUser | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [deletingBusy, setDeletingBusy] = useState(false);
  const activeUsers = users.filter((entry) => entry.active).length;
  const load = async () => { const response = await fetch("/api/users", { credentials: "same-origin", cache: "no-store" }); const body = await response.json() as { users?: WebUser[]; error?: string }; if (!response.ok || !body.users) throw new Error(body.error ?? "No fue posible cargar usuarios."); setUsers(body.users); };
  useEffect(() => { const frame = window.requestAnimationFrame(() => { load().catch((caught) => setError(caught instanceof Error ? caught.message : "No fue posible cargar usuarios.")).finally(() => setLoading(false)); }); return () => window.cancelAnimationFrame(frame); }, []);
  const save = async (payload: { name: string; email?: string; role: UserRole; permissions: Permission[]; active: boolean }) => { const creating = editing === "new"; const response = await fetch(creating ? "/api/users" : `/api/users/${(editing as WebUser).id}`, { method: creating ? "POST" : "PATCH", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }); const body = await response.json() as { user?: WebUser; temporaryPassword?: string; error?: string }; if (!response.ok) throw new Error(body.error ?? "No fue posible guardar el usuario."); await load(); if (body.temporaryPassword) setTemporary({ name: payload.name, password: body.temporaryPassword }); setEditing(null); };
  const toggle = async (entry: WebUser) => { await saveDirect(entry, { active: !entry.active }); };
  const saveDirect = async (entry: WebUser, patch: { active?: boolean }) => { const response = await fetch(`/api/users/${entry.id}`, { method: "PATCH", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: entry.name, role: entry.role, permissions: entry.permissions, active: patch.active ?? entry.active }) }); const body = await response.json() as { error?: string }; if (!response.ok) throw new Error(body.error ?? "No fue posible actualizar el usuario."); await load(); };
  const reset = async (entry: WebUser) => { const response = await fetch(`/api/users/${entry.id}/reset-password`, { method: "POST", credentials: "same-origin" }); const body = await response.json() as { temporaryPassword?: string; error?: string }; if (!response.ok || !body.temporaryPassword) throw new Error(body.error ?? "No fue posible restablecer la contraseña."); setTemporary({ name: entry.name, password: body.temporaryPassword }); await load(); };
  const remove = async (entry: WebUser) => {
    setDeletingBusy(true);
    setDeleteError("");
    try {
      const response = await fetch(`/api/users/${entry.id}`, { method: "DELETE", credentials: "same-origin" });
      const body = await response.json() as { deleted?: boolean; error?: string };
      if (!response.ok || !body.deleted) throw new Error(body.error ?? "No fue posible eliminar el usuario.");
      await load();
      setDeleting(null);
      setNotice(`${entry.name} fue eliminado definitivamente de la base de datos.`);
    } catch (caught) {
      setDeleteError(caught instanceof Error ? caught.message : "No fue posible eliminar el usuario.");
    } finally {
      setDeletingBusy(false);
    }
  };
  return <div className="user-admin">
    <section className="panel user-summary"><div><span className="eyebrow">Gobierno de acceso</span><h2>{activeUsers} {activeUsers === 1 ? "cuenta activa" : "cuentas activas"}</h2><p>Cada rol parte con permisos mínimos y puede limitarse antes de enrolar la cuenta.</p></div><button className="primary-button" onClick={() => setEditing("new")}>＋ Enrolar usuario</button></section>
    {error && <div className="auth-error" role="alert"><span>!</span>{error}</div>}
    {notice && <div className="access-notice" role="status"><span>✓</span>{notice}</div>}
    <section className="panel user-list">
      <div className="user-list-head"><span>Usuario</span><span>Rol y permisos</span><span>Estado</span><span>Acciones</span></div>
      {loading ? <div className="user-loading">Cargando cuentas protegidas…</div> : users.map((entry) => <article className="user-row" key={entry.id}>
        <div className="user-identity"><span className="large-avatar small">{initials(entry.name)}</span><div><strong>{entry.name}</strong><small>{entry.email ?? "Correo maestro protegido"}</small></div></div>
        <div className="user-role"><strong>{roleCopy[entry.role]}</strong><UserPermissionDisclosure user={entry} /></div>
        <span className={`user-state ${entry.active ? "active" : "inactive"}`}><i />{entry.active ? "Activa" : "Suspendida"}</span>
        <div className="user-actions">{entry.isMaster ? <span className="master-lock">Cuenta protegida</span> : <><button className="text-button" onClick={() => setEditing(entry)}>Editar</button><button className="text-button" onClick={() => reset(entry).catch((caught) => setError(caught instanceof Error ? caught.message : "Error"))}>Restablecer clave</button><button className="text-button" onClick={() => toggle(entry).catch((caught) => setError(caught instanceof Error ? caught.message : "Error"))}>{entry.active ? "Suspender" : "Activar"}</button>{canDeleteUsers && <button className="text-button danger-text" onClick={() => { setDeleteError(""); setDeleting(entry); }}>Eliminar</button>}</>}</div>
      </article>)}
    </section>
    <section className="panel recovery-policy"><span className="lock-mark">⌾</span><div><h3>Recuperación en dos niveles</h3><p>El usuario maestro restablece claves temporales para el equipo. Si pierde su propia clave, utiliza el código offline; con acceso físico también puede reprovisionarla en la Raspberry.</p></div></section>
    {editing && <div className="modal-backdrop" role="presentation"><section className="modal user-modal" role="dialog" aria-modal="true" aria-label={editing === "new" ? "Enrolar usuario" : "Editar usuario"}><button className="modal-close" onClick={() => setEditing(null)} aria-label="Cerrar">×</button><UserEditor value={editing === "new" ? null : editing} onSave={save} onCancel={() => setEditing(null)} /></section></div>}
    {temporary && <div className="modal-backdrop" role="presentation"><section className="modal credential-modal" role="dialog" aria-modal="true" aria-label="Contraseña temporal"><button className="modal-close" onClick={() => setTemporary(null)} aria-label="Cerrar">×</button><span className="eyebrow">ENTREGA ÚNICA</span><h2>Credencial temporal de {temporary.name}</h2><p>Compártela por un canal seguro. Al ingresar, el usuario deberá reemplazarla obligatoriamente.</p><code>{temporary.password}</code><button className="secondary-button" onClick={() => navigator.clipboard.writeText(temporary.password)}>Copiar contraseña</button><div className="form-note"><span>i</span>Esta contraseña no volverá a mostrarse después de cerrar la ventana.</div><button className="primary-button" onClick={() => setTemporary(null)}>Entendido</button></section></div>}
    {deleting && <div className="modal-backdrop" role="presentation"><section className="modal" role="dialog" aria-modal="true" aria-label="Eliminar usuario definitivamente"><button className="modal-close" onClick={() => setDeleting(null)} aria-label="Cerrar">×</button><div className="delete-confirm"><span className="danger-mark">!</span><ModalIntro eyebrow="ELIMINACIÓN DEFINITIVA" title="Eliminar usuario de la base de datos" detail="Esta acción no se puede deshacer y cerrará su acceso al sistema." /><div className="delete-target"><small>USUARIO A ELIMINAR</small><strong>{deleting.name}</strong><span>{deleting.email}</span></div><p>Se eliminarán la cuenta, sus credenciales de acceso y permisos. La acción quedará registrada en la auditoría del sistema.</p>{deleteError && <div className="auth-error" role="alert"><span>!</span>{deleteError}</div>}<div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setDeleting(null)} disabled={deletingBusy}>Cancelar</button><button className="danger-button" type="button" onClick={() => remove(deleting)} disabled={deletingBusy}>{deletingBusy ? "Eliminando…" : "Eliminar definitivamente"}</button></div></div></section></div>}
  </div>;
}

function UserPermissionDisclosure({ user }: { user: WebUser }) {
  const available = user.role === "master" ? Object.keys(permissionCopy) as Permission[] : rolePreset[user.role];
  return <details className="permission-disclosure"><summary>{user.permissions.length} de {available.length} permisos activos</summary><ul>{available.map((permission) => { const enabled = user.permissions.includes(permission); return <li className={enabled ? "enabled" : "disabled"} key={permission}><span>{enabled ? "✓" : "–"}</span><div><strong>{permissionCopy[permission]}</strong><small>{enabled ? "Asignado a esta cuenta" : "Disponible para el rol, no asignado"}</small></div></li>; })}</ul></details>;
}

function UserEditor({ value, onSave, onCancel }: { value: WebUser | null; onSave: (payload: { name: string; email?: string; role: UserRole; permissions: Permission[]; active: boolean }) => Promise<void>; onCancel: () => void }) {
  const initialRole = value?.role === "master" ? "administrator" : value?.role ?? "supervisor";
  const [role, setRole] = useState<Exclude<UserRole, "master">>(initialRole as Exclude<UserRole, "master">);
  const [permissions, setPermissions] = useState<Permission[]>(value?.permissions ?? rolePreset[role]);
  const [error, setError] = useState(""); const [submitting, setSubmitting] = useState(false);
  const changeRole = (next: Exclude<UserRole, "master">) => { setRole(next); setPermissions(rolePreset[next]); };
  const submit = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); setSubmitting(true); setError(""); try { await onSave({ name: String(form.get("name")), email: value ? undefined : String(form.get("email")), role, permissions, active: value?.active ?? true }); } catch (caught) { setError(caught instanceof Error ? caught.message : "No fue posible guardar."); setSubmitting(false); } };
  return <form onSubmit={submit}><ModalIntro eyebrow={value ? "Editar cuenta" : "Nuevo acceso"} title={value ? value.name : "Enrolar usuario"} detail="El tipo de usuario propone un conjunto seguro de permisos que puedes reducir antes de guardar." /><div className="form-grid"><label>Nombre completo<input name="name" defaultValue={value?.name} required /></label>{!value && <label>Correo electrónico<input name="email" type="email" autoComplete="off" required /></label>}<label className="full">Tipo de usuario<select value={role} onChange={(event) => changeRole(event.target.value as Exclude<UserRole, "master">)}><option value="administrator">Administrador</option><option value="supervisor">Supervisor operacional</option><option value="viewer">Consulta</option></select></label></div><div className="permission-editor"><strong>Permisos efectivos</strong><p>Sólo se muestran permisos compatibles con el rol seleccionado.</p>{rolePreset[role].map((permission) => <div className="permission-option" key={permission}><input id={`permission-${permission}`} type="checkbox" checked={permissions.includes(permission)} disabled={permission === "view_dashboard"} onChange={(event) => setPermissions((items) => event.target.checked ? [...items, permission] : items.filter((item) => item !== permission))} /><label htmlFor={`permission-${permission}`}><b>{permissionCopy[permission]}</b><small>{permission === "manage_users" ? "Permite administrar cuentas; la eliminación definitiva queda reservada al usuario maestro." : "Aplicado inmediatamente al próximo ingreso."}</small></label></div>)}</div>{error && <div className="auth-error" role="alert"><span>!</span>{error}</div>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={onCancel}>Cancelar</button><button className="primary-button" disabled={submitting}>{submitting ? "Guardando…" : value ? "Guardar cambios" : "Enrolar y generar clave"}</button></div></form>;
}

function SystemView({ edge, sensor, online, canManage, onRefresh, onReset }: { edge: FuelHistoryResponse["edge"]; sensor: FuelHistoryResponse["sensor"] | null; online: boolean; canManage: boolean; onRefresh: () => Promise<void>; onReset: (password: string) => Promise<void> }) {
  const reportedAt = edge ? formatAlertDate(edge.occurredAt) : "Sin reporte recibido";
  const components = [
    ["PLC", "Raspberry PLC 19R", edge ? `Estado: ${edge.state}` : "Esperando telemetría", online],
    ["VA", "Validador RFID/BLE", edge?.validatorOnline ? "Conectado" : "Sin conexión confirmada", Boolean(edge?.validatorOnline && online)],
    ["NF", "Lector NFC", edge?.nfcReady ? "RC522 disponible" : "No disponible", Boolean(edge?.nfcReady && online)],
    ["K2", "Medidor K24 Pulser", !edge?.k24Enabled ? "Pendiente de conexión" : edge.k24Healthy ? "Telemetría saludable" : "Requiere revisión", Boolean(edge?.k24Enabled && edge?.k24Healthy && online)],
    ["OC", "Sensor PIUSI OCIO", !edge?.tankLevelEnabled ? "Pendiente de conexión" : sensor?.latestReadingAt && !sensor.latestReadingAt.startsWith("1970") ? formatCompactLiters(sensor.currentLevel) : "Esperando primera lectura", Boolean(edge?.tankLevelEnabled && sensor?.latestReadingAt && !sensor.latestReadingAt.startsWith("1970"))],
  ] as const;
  return <div className="system-layout"><div className="system-primary"><section className="panel system-health"><div className="health-hero"><span className="health-ring">{online ? "✓" : "!"}</span><div><span className="eyebrow">Estado general</span><h2>{online ? "Controlador edge reportando" : "Controlador sin reporte reciente"}</h2><p>Último estado recibido: {reportedAt}. La Raspberry mantiene la autoridad sobre R0.1.</p></div><strong>{edge?.relayEnergized ? "Bomba habilitada" : "Relé abierto"}<small>estado informado por el PLC</small></strong></div><div className="component-list">{components.map((item) => <div className="component-row" key={item[1]}><span className="component-mark">{item[0]}</span><div><strong>{item[1]}</strong><small>{item[2]}</small></div><span className={`component-online ${item[3] ? "" : "offline"}`}><i />{item[3] ? "En línea" : "Sin confirmar"}</span><time>{item[0] === "OC" && sensor?.latestReadingAt && !sensor.latestReadingAt.startsWith("1970") ? formatAlertDate(sensor.latestReadingAt) : reportedAt}</time></div>)}</div></section><BluetoothCalibration /></div><aside className="system-side">{canManage && <RelayTestPanel edge={edge} online={online} onRefresh={onRefresh} />}{canManage && <FuelDataResetPanel onReset={onReset} />}<section className="panel protected-card"><span className="lock-mark">⌾</span><div><h3>Configuración protegida</h3><p>Calibraciones, certificados y pruebas físicas requieren permiso de administración del sistema.</p></div></section><section className="panel version-card"><div><small>fuel-edge</small><strong>v0.3.10</strong></div><span>{edge?.moduleId ?? "Módulo pendiente"}<br />{edge?.siteId ?? "Fundo Santa Isabel"}</span></section></aside></div>;
}

function FuelDataResetPanel({ onReset }: { onReset: (password: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const passwordInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const focusFrame = window.requestAnimationFrame(() => passwordInput.current?.focus());
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) setOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", close);
    };
  }, [open, submitting]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const password = String(new FormData(form).get("administratorPassword"));
    setSubmitting(true);
    setError("");
    try {
      await onReset(password);
      form.reset();
      setOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No fue posible reiniciar la base de carga y nivel.");
    } finally {
      setSubmitting(false);
    }
  };

  return <>
    <section className="panel fuel-reset-card">
      <div className="fuel-reset-heading"><span className="fuel-reset-mark">↺</span><div><span className="eyebrow">Inicio en terreno</span><h2>Base de carga y nivel</h2></div></div>
      <p>Elimina el histórico de cargas, las lecturas de nivel y el estado acumulado del detector para comenzar un registro limpio.</p>
      <button className="danger-button" type="button" onClick={() => { setError(""); setOpen(true); }}>Reiniciar base de datos</button>
    </section>
    {open && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !submitting && setOpen(false)}>
      <section className="modal fuel-reset-modal" role="dialog" aria-modal="true" aria-labelledby="fuel-reset-title">
        <button className="modal-close" type="button" disabled={submitting} onClick={() => setOpen(false)} aria-label="Cerrar">×</button>
        <form onSubmit={submit}>
          <span className="danger-mark">!</span>
          <div className="modal-intro"><span className="eyebrow">Acción de administrador</span><h2 id="fuel-reset-title">Reiniciar carga y nivel</h2><p>Esta acción elimina definitivamente todas las cargas y lecturas anteriores. La siguiente lectura OCIO establecerá el nivel inicial del registro en terreno.</p></div>
          <div className="form-note warning"><span>!</span>Los operadores, equipos, asociaciones y credenciales no serán eliminados.</div>
          <label className="fuel-reset-password">Clave de administrador<input ref={passwordInput} name="administratorPassword" type="password" autoComplete="current-password" required maxLength={256} /></label>
          {error && <div className="auth-error" role="alert"><span>!</span>{error}</div>}
          <div className="modal-actions"><button className="secondary-button" type="button" disabled={submitting} onClick={() => setOpen(false)}>Cancelar</button><button className="danger-button" type="submit" disabled={submitting}>{submitting ? "Verificando y reiniciando…" : "Reiniciar y comenzar registro"}</button></div>
        </form>
      </section>
    </div>}
  </>;
}

function RelayTestPanel({ edge, online, onRefresh }: { edge: FuelHistoryResponse["edge"]; online: boolean; onRefresh: () => Promise<void> }) {
  const [command, setCommand] = useState<RelayTestCommand | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState("");
  const [clock, setClock] = useState(0);
  const active = command?.status === "pending" || command?.status === "running";
  const available = Boolean(online && edge?.state === "locked" && !edge.relayEnergized && edge.k24Enabled && edge.k24Healthy && !active);
  const startedAtMilliseconds = command?.startedAt ? new Date(command.startedAt).getTime() : Number.NaN;
  const elapsedSeconds = Number.isFinite(startedAtMilliseconds)
    ? Math.max(0, Math.floor((clock - startedAtMilliseconds) / 1000))
    : 0;
  const remaining = command?.status === "running"
    ? Math.max(0, Math.min(command.durationSeconds, command.durationSeconds - elapsedSeconds))
    : 10;

  useEffect(() => {
    if (!active || !command) return;
    let cancelled = false;
    const poll = async () => {
      const response = await fetch(`/api/relay-test/${encodeURIComponent(command.id)}`, { credentials: "same-origin", cache: "no-store" });
      const body = await response.json() as { command?: RelayTestCommand; error?: string };
      if (!response.ok || !body.command) throw new Error(body.error ?? "No fue posible consultar la prueba.");
      if (cancelled) return;
      setCommand(body.command);
      if (["completed", "failed", "expired"].includes(body.command.status)) await onRefresh();
    };
    const statusTimer = window.setInterval(() => poll().catch((caught) => !cancelled && setError(caught instanceof Error ? caught.message : "No fue posible consultar la prueba.")), 500);
    const clockTimer = window.setInterval(() => setClock(Date.now()), 250);
    return () => { cancelled = true; window.clearInterval(statusTimer); window.clearInterval(clockTimer); };
  }, [active, command, onRefresh]);

  const start = async () => {
    if (!window.confirm("R0.1 se energizará durante 10 segundos. Confirma que la zona y el circuito están preparados para la prueba.")) return;
    setRequesting(true); setError("");
    try {
      const response = await fetch("/api/relay-test", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      const body = await response.json() as { command?: RelayTestCommand; error?: string };
      if (!response.ok || !body.command) throw new Error(body.error ?? "No fue posible iniciar la prueba de relé.");
      setCommand(body.command); setClock(Date.now());
    } catch (caught) { setError(caught instanceof Error ? caught.message : "No fue posible iniciar la prueba de relé."); }
    finally { setRequesting(false); }
  };

  const statusCopy = command?.status === "completed" ? "Prueba completada; R0.1 volvió a LOW"
    : command?.status === "failed" ? command.error ?? "La prueba fue interrumpida"
      : command?.status === "expired" ? command.error ?? "La solicitud venció"
        : command?.status === "running" ? `Relé activo · ${remaining} s restantes`
          : command?.status === "pending" ? "Esperando a la Raspberry…" : "Disponible con el punto bloqueado";
  return <section className={`panel relay-test-card ${command?.status ?? "idle"}`}><div className="relay-test-heading"><span className="relay-test-mark">R</span><div><span className="eyebrow">Mantenimiento local</span><h2>Test de relé R0.1</h2></div></div><p>Energiza la salida durante 10 segundos. La Raspberry bloquea nuevas cargas y abre antes si K24 detecta flujo o aparece una falla.</p>{command?.status === "running" && <div className="relay-test-progress" role="progressbar" aria-label="Tiempo restante de la prueba" aria-valuemin={0} aria-valuemax={10} aria-valuenow={10 - remaining}><span style={{ width: `${(10 - remaining) * 10}%` }} /></div>}<strong className="relay-test-status" role="status">{statusCopy}</strong>{error && <small className="relay-test-error" role="alert">{error}</small>}<button className="primary-button compact" type="button" disabled={!available || requesting} onClick={() => void start()}>{requesting ? "Solicitando…" : active ? "Prueba en curso" : "Probar relé por 10 s"}</button>{!online && <small>El controlador debe estar reportando para habilitar la prueba.</small>}{online && edge?.state !== "locked" && !active && <small>Disponible sólo cuando el estado sea LOCKED.</small>}{online && (!edge?.k24Enabled || !edge.k24Healthy) && !active && <small>K24 debe estar habilitado y saludable.</small>}</section>;
}

function BluetoothCalibration() {
  const [settings, setSettings] = useState<BluetoothSettings | null>(null);
  const [threshold, setThreshold] = useState(-70);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const load = useCallback(async () => {
    const response = await fetch("/api/system-settings/bluetooth", { credentials: "same-origin", cache: "no-store" });
    const body = await response.json() as { settings?: BluetoothSettings; error?: string };
    if (!response.ok || !body.settings) throw new Error(body.error ?? "No fue posible cargar la calibración Bluetooth.");
    setSettings(body.settings);
    if (!dirtyRef.current) setThreshold(body.settings.rssiThreshold);
  }, []);
  useEffect(() => {
    const initial = window.setTimeout(() => {
      load().catch((caught) => setError(caught instanceof Error ? caught.message : "No fue posible cargar la calibración."));
    }, 0);
    const timer = window.setInterval(() => load().catch(() => undefined), 3000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [load]);
  const save = async () => {
    setSaving(true); setError("");
    try {
      const response = await fetch("/api/system-settings/bluetooth", {
        method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rssiThreshold: threshold }),
      });
      const body = await response.json() as { settings?: BluetoothSettings; error?: string };
      if (!response.ok || !body.settings) throw new Error(body.error ?? "No fue posible guardar la calibración.");
      setSettings(body.settings); setThreshold(body.settings.rssiThreshold); setDirty(false); dirtyRef.current = false;
    } catch (caught) { setError(caught instanceof Error ? caught.message : "No fue posible guardar la calibración."); }
    finally { setSaving(false); }
  };
  const applied = Boolean(!dirty && settings && settings.appliedRevision === settings.revision
    && settings.appliedThreshold === settings.rssiThreshold);
  const relation = settings?.lastObservedRssi === null || settings?.lastObservedRssi === undefined
    ? "Aún no hay una medición del validador. Presenta una credencial con el MIM ubicado en el límite deseado."
    : settings.lastObservedRssi >= threshold
      ? `La última medición (${settings.lastObservedRssi} dBm) sería aceptada con este umbral.`
      : `La última medición (${settings.lastObservedRssi} dBm) quedaría fuera de la zona autorizada.`;
  return <section className="panel bluetooth-calibration"><div className="calibration-heading"><span className="bluetooth-mark">B</span><div><span className="eyebrow">Zona de carga</span><h2>Calibración de proximidad Bluetooth</h2><p>Define la intensidad mínima que debe recibir el validador desde el MIM. Un valor menos negativo exige mayor cercanía.</p></div><span className={`apply-state ${applied ? "applied" : "pending"}`}><i />{applied ? "Aplicado en el validador" : "Esperando confirmación"}</span></div><div className="calibration-control"><div className="threshold-value"><strong>{threshold}</strong><span>dBm</span><small>{threshold >= -55 ? "Zona muy cercana" : threshold >= -70 ? "Zona cercana" : threshold >= -85 ? "Zona amplia" : "Zona muy amplia"}</small></div><label><span>Más alcance</span><input type="range" min="-100" max="-35" step="1" value={threshold} onChange={(event) => { setThreshold(Number(event.target.value)); setDirty(true); dirtyRef.current = true; }} /><span>Más cercanía</span></label><button className="primary-button compact" type="button" disabled={saving || threshold === settings?.rssiThreshold} onClick={() => save()}>{saving ? "Guardando…" : "Aplicar umbral"}</button></div><div className="calibration-evidence"><span className="signal-sample">{settings?.lastObservedRssi ?? "—"} <small>dBm medidos</small></span><div><strong>{relation}</strong><small>{settings?.lastObservedModule ? `MIM ${settings.lastObservedModule} · ${settings.observedAt ? formatAlertDate(settings.observedAt) : "sin fecha"}` : "La medición se registra en el validador, no en el Bluetooth de la Raspberry."}</small></div></div>{error && <div className="auth-error" role="alert"><span>!</span>{error}</div>}<small className="calibration-note">Calibra con el tractor detenido en el borde real de la zona. Guarda un umbral 3–6 dB mayor que la lectura del borde para evitar autorizaciones fuera del área.</small></section>;
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="empty-state"><span>⌕</span><strong>{title}</strong><p>{detail}</p></div>;
}

function ModalLayer({ modal, alerts, transactions, operators, rfidCredentials, equipment, candidates, userName, canManageAlerts, isProviderAdmin, onClose, onAddOperator, onAddEquipment, onAddAssociation, onEnrollEquipment, onNfcEnrolled, onAssignRfid, onDeleteRfid, onPermanentDelete, onUpdateAlert }: { modal: NonNullable<Modal>; alerts: AlertItem[]; transactions: Transaction[]; operators: Operator[]; rfidCredentials: RfidCredential[]; equipment: Equipment[]; candidates: EnrollmentCandidate[]; userName: string; canManageAlerts: boolean; isProviderAdmin: boolean; onClose: () => void; onAddOperator: (item: Operator) => Promise<void>; onAddEquipment: (item: Equipment) => void; onAddAssociation: (item: Association) => void; onEnrollEquipment: (moduleId: string, assignment: EnrollmentAssignment) => Promise<void>; onNfcEnrolled: () => Promise<void>; onAssignRfid: (credentialId: string, operatorId: string | null) => Promise<void>; onDeleteRfid: (credentialId: string) => Promise<void>; onPermanentDelete: (type: ManagedEntityType, id: string) => void; onUpdateAlert: (alertId: string, update: { description: string; status: AlertStatus; priority: AlertPriority }) => Promise<void> }) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  const transaction = modal.type === "transaction" ? transactions.find((item) => item.id === modal.id) : null;
  const selectedEquipment = modal.type === "equipmentDetail" ? equipment.find((item) => item.id === modal.id) : null;
  const selectedAlert = modal.type === "alertDetail" ? alerts.find((item) => item.id === modal.alertId) : null;
  const enrollmentCandidate = modal.type === "equipmentEnrollment" ? candidates.find((item) => item.moduleId === modal.moduleId) : null;
  const enrolledEquipment = enrollmentCandidate ? equipment.find((item) => item.module === enrollmentCandidate.moduleId && !item.archivedAt) : null;
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className={`modal ${modal.type === "alertDetail" ? "alert-detail-modal" : ""}`} role="dialog" aria-modal="true" aria-labelledby="modal-title">
    <button className="modal-close" onClick={onClose} aria-label="Cerrar">×</button>
    {modal.type === "operator" && <OperatorForm onSubmit={onAddOperator} onCancel={onClose} />}
    {modal.type === "equipment" && <EquipmentForm onSubmit={onAddEquipment} onCancel={onClose} />}
    {modal.type === "association" && <AssociationForm operators={operators.filter((item) => !item.archivedAt)} equipment={equipment.filter((item) => !item.archivedAt)} onSubmit={onAddAssociation} onCancel={onClose} />}
    {modal.type === "enroll" && isProviderAdmin && <EnrollModal operatorId={modal.operatorId} operatorName={modal.operatorName} credentialIsMaster={modal.credentialIsMaster} onCompleted={onNfcEnrolled} onClose={onClose} />}
    {modal.type === "createCredential" && isProviderAdmin && <CreateCredentialModal operators={operators} credentials={rfidCredentials} onCompleted={onNfcEnrolled} onClose={onClose} />}
    {(modal.type === "enroll" || modal.type === "createCredential") && !isProviderAdmin && <EmptyState title="Enrolamiento restringido" detail="Sólo la cuenta maestra del proveedor tecnológico puede agregar credenciales RFID." />}
    {modal.type === "rfidAssignment" && <RfidAssignmentForm credentials={rfidCredentials} operators={operators} initialCredentialId={modal.credentialId} onSubmit={onAssignRfid} onCancel={onClose} />}
    {modal.type === "deleteCredential" && <RfidDeleteConfirm credentialId={modal.credentialId} onConfirm={() => onDeleteRfid(modal.credentialId)} onCancel={onClose} />}
    {modal.type === "identifyCredential" && <IdentifyCredentialModal onClose={onClose} />}
    {modal.type === "transaction" && (transaction ? <TransactionDetail item={transaction} /> : <EmptyState title="Carga no disponible" detail="Actualiza la lista e inténtalo nuevamente." />)}
    {modal.type === "equipmentDetail" && (selectedEquipment ? <EquipmentDetail item={selectedEquipment} /> : <EmptyState title="Equipo no disponible" detail="El registro fue actualizado o archivado." />)}
    {modal.type === "equipmentEnrollment" && (enrollmentCandidate ? <EquipmentEnrollmentForm candidate={enrollmentCandidate} equipment={enrolledEquipment ?? undefined} onSubmit={(assignment) => onEnrollEquipment(enrollmentCandidate.moduleId, assignment)} onCancel={onClose} /> : <EmptyState title="Módulo fuera de alcance" detail="Energízalo nuevamente para continuar." />)}
    {modal.type === "alertDetail" && (selectedAlert ? <AlertDetail alert={selectedAlert} userName={userName} canManage={canManageAlerts} onSubmit={(update) => onUpdateAlert(modal.alertId, update)} /> : <EmptyState title="Alerta no disponible" detail="La alerta ya fue actualizada." />)}
    {modal.type === "permanentDelete" && <PermanentDeleteConfirm name={modal.name} type={modal.entityType} onConfirm={() => onPermanentDelete(modal.entityType, modal.id)} onCancel={onClose} />}
  </section></div>;
}

function EquipmentEnrollmentForm({ candidate, equipment, onSubmit, onCancel }: { candidate: EnrollmentCandidate; equipment?: Equipment; onSubmit: (assignment: EnrollmentAssignment) => Promise<void>; onCancel: () => void }) {
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get("name")).trim();
    const kind = String(data.get("kind")) as EquipmentKind;
    const validUntil = new Date(String(data.get("validUntil"))).toISOString();
    setSubmitting(true); setError("");
    try { await onSubmit({ name, kind, validUntil }); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "No fue posible enrolar el módulo."); setSubmitting(false); }
  };
  const revalidating = Boolean(equipment || candidate.claimed);
  return <form onSubmit={submit}><ModalIntro eyebrow="MIM DETECTADO Y VERIFICADO" title={revalidating ? "Asignar MIM a este fundo" : "Crear asignación temporal"} detail="La identidad del Módulo Identificador de Máquina se conserva. Aquí defines el equipo y hasta cuándo puede operar en el fundo actual." /><div className="enrollment-device-summary"><span className="bluetooth-mark">W</span><div><strong>{candidate.moduleId}</strong><small>{candidate.siteId} · enlace Wi-Fi {candidate.rssi} dBm</small></div></div><div className="form-grid"><label className="full">Nombre visible<input name="name" required minLength={3} maxLength={80} defaultValue={equipment?.name ?? candidate.requestedName ?? candidate.deviceName ?? ""} placeholder="Ej. Tractor John Deere 6155M" /></label><label>Tipo<select name="kind" required defaultValue={equipment?.kind ?? candidate.requestedKind ?? "Tractor"}><option>Tractor</option><option>Trilladora</option><option>Cuatrimoto</option></select></label><label>Vence en este fundo<input name="validUntil" type="datetime-local" required min={localDateTimeFromNow(0, 15)} defaultValue={localDateTimeFromNow(7)} /></label></div>{error && <div className="auth-error" role="alert"><span>!</span>{error}</div>}<div className="form-note success"><span>✓</span>Al vencer, la carga queda bloqueada. Para renovar o reasignar, mantén presionado 8 segundos el botón del MIM durante el arranque.</div><div className="modal-actions"><button type="button" className="secondary-button" onClick={onCancel}>Cancelar</button><button className="primary-button" disabled={submitting}>{submitting ? "Validando…" : revalidating ? "Asignar y revalidar" : "Nombrar y enrolar"}</button></div></form>;
}

function ModalIntro({ eyebrow, title, detail }: { eyebrow: string; title: string; detail: string }) {
  return <div className="modal-intro"><span className="eyebrow">{eyebrow}</span><h2 id="modal-title">{title}</h2><p>{detail}</p></div>;
}

function OperatorForm({ onSubmit, onCancel }: { onSubmit: (item: Operator) => Promise<void>; onCancel: () => void }) {
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const rut = String(data.get("rut")).trim();
    if (!validChileanRut(rut)) {
      setError("El RUT ingresado no es válido. Revisa el número y dígito verificador.");
      return;
    }
    setSubmitting(true); setError("");
    try {
      await onSubmit({ id: `op-${Date.now()}`, name: String(data.get("name")).trim(), rut, credential: "Sin enrolar", credentialActive: false, credentialIsMaster: false, active: true, lastUse: "Sin actividad" });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No fue posible crear el operador.");
      setSubmitting(false);
    }
  };
  return <form onSubmit={submit}><ModalIntro eyebrow="Nuevo registro" title="Crear operador" detail="Después de guardar podrás iniciar el enrolamiento de su credencial NFC." /><div className="form-grid"><label className="full">Nombre completo<input name="name" required minLength={3} placeholder="Ej. Juan Pérez" /></label><label>RUT<input name="rut" required autoComplete="off" placeholder="12.345.678-5" aria-describedby={error ? "operator-rut-error" : undefined} /></label><label>Tipo de operador<select name="type" defaultValue="Maquinaria"><option>Maquinaria</option><option>Encargado</option><option>Contratista</option></select></label><label className="full">Nota opcional<textarea name="note" rows={3} placeholder="Información útil para la administración local" /></label></div>{error && <div id="operator-rut-error" className="auth-error modal-form-error" role="alert"><span>!</span>{error}</div>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={onCancel}>Cancelar</button><button className="primary-button" type="submit" disabled={submitting}>{submitting ? "Creando…" : "Crear operador"}</button></div></form>;
}

function EquipmentForm({ onSubmit, onCancel }: { onSubmit: (item: Equipment) => void; onCancel: () => void }) {
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const data = new FormData(event.currentTarget); const condition = String(data.get("condition")) as Equipment["condition"]; const expiryValue = String(data.get("expiry")); onSubmit({ id: `eq-${Date.now()}`, name: String(data.get("name")), kind: String(data.get("kind")) as EquipmentKind, condition, module: String(data.get("module")) || "Sin módulo", siteId: "", active: true, expiry: condition === "Permanente" || !expiryValue ? undefined : new Date(expiryValue).toISOString() }); };
  return <form onSubmit={submit}><ModalIntro eyebrow="Inventario" title="Crear equipo abastecible" detail="El equipo quedará disponible para asociarlo con operadores activos." /><div className="form-grid"><label className="full">Nombre del equipo<input name="name" required placeholder="Ej. Tractor John Deere 6155M" /></label><label>Tipo<select name="kind" required defaultValue="Tractor"><option>Tractor</option><option>Trilladora</option><option>Cuatrimoto</option></select></label><label>Condición<select name="condition" defaultValue="Permanente"><option>Permanente</option><option>Temporal</option><option>Externo</option></select></label><label>Módulo ESP32<input name="module" placeholder="KT-MOD-0000" /></label><label>Vigencia temporal<input name="expiry" type="datetime-local" min={localDateTimeFromNow(0, 15)} /></label></div><div className="form-note"><span>i</span>Los módulos temporales se validan físicamente por Bluetooth antes de renovar su vigencia en un fundo.</div><div className="modal-actions"><button type="button" className="secondary-button" onClick={onCancel}>Cancelar</button><button className="primary-button" type="submit">Crear equipo</button></div></form>;
}

function AssociationForm({ operators, equipment, onSubmit, onCancel }: { operators: Operator[]; equipment: Equipment[]; onSubmit: (item: Association) => void; onCancel: () => void }) {
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const data = new FormData(event.currentTarget); onSubmit({ id: `as-${Date.now()}`, operatorId: String(data.get("operator")), equipmentId: String(data.get("equipment")), active: true, since: "10 ago 2026" }); };
  return <form onSubmit={submit}><ModalIntro eyebrow="Autorización local" title="Nueva asociación" detail="Vincula un operador habilitado con un equipo disponible." /><div className="association-form"><label>Operador<select name="operator" required>{operators.filter((item) => item.active).map((item) => <option value={item.id} key={item.id}>{item.name} · {item.credential}</option>)}</select></label><div className="association-form-link">↕</div><label>Equipo<select name="equipment" required>{equipment.filter((item) => item.active).map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label></div><div className="form-note success"><span>✓</span>La asociación entrará en vigencia inmediatamente y quedará registrada en la auditoría local.</div><div className="modal-actions"><button type="button" className="secondary-button" onClick={onCancel}>Cancelar</button><button className="primary-button" type="submit">Crear asociación</button></div></form>;
}

function AlertDetail({ alert, userName, canManage, onSubmit }: { alert: AlertItem; userName: string; canManage: boolean; onSubmit: (update: { description: string; status: AlertStatus; priority: AlertPriority }) => Promise<void> }) {
  const [status, setStatus] = useState<AlertStatus>(alert.status);
  const [priority, setPriority] = useState<AlertPriority>(alert.priority);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const description = String(data.get("comment")).trim();
    if (description.length < 10) return;
    setSubmitting(true); setError("");
    try {
      await onSubmit({ description, status, priority });
      form.reset();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No fue posible guardar el seguimiento.");
    } finally {
      setSubmitting(false);
    }
  };
  return <div className="alert-detail">
    <ModalIntro eyebrow="Seguimiento de alerta" title={alert.title} detail="Revisa la criticidad, registra avances y resuelve la alerta sólo cuando el trabajo haya terminado." />
    <div className="alert-detail-summary"><span className={`alert-priority-mark ${alert.priority}`} aria-hidden="true">{alert.priority === "urgent" ? "!" : alert.priority === "high" ? "↑" : alert.priority === "medium" ? "•" : "↓"}</span><div><div><span className={`priority-badge ${alert.priority}`}>{alertPriorityCopy[alert.priority]}</span><span className={`alert-status-badge ${alert.status}`}>{alertStatusCopy[alert.status]}</span></div><p>{alert.detail}</p><time>{formatAlertDate(alert.time)}</time></div></div>
    <section className="alert-comment-history"><div className="alert-history-heading"><h3>Historial de comentarios</h3><span>{alert.comments?.length ?? 0} registros</span></div>{canManage ? (alert.comments?.length ? <ol>{alert.comments.map((entry) => <li key={entry.id}><span className={`comment-dot ${entry.statusAfter}`} /><div><div><strong>{entry.actor}</strong><time>{formatAlertDate(entry.recordedAt)}</time></div><p>{entry.comment}</p><small>{alertStatusCopy[entry.statusAfter]} · Prioridad {alertPriorityCopy[entry.priorityAfter]}</small></div></li>)}</ol> : <div className="alert-history-empty">Aún no hay comentarios. Registra la primera revisión debajo.</div>) : <div className="alert-history-empty protected">El historial está disponible para el administrador principal y los encargados autorizados.</div>}</section>
    {canManage && alert.status !== "resolved" && <form className="alert-follow-up-form" onSubmit={submit}><div className="form-grid"><label>Estado al guardar<select name="status" value={status} onChange={(event) => setStatus(event.target.value as AlertStatus)}><option value="pending">Pendiente</option><option value="in_progress">Tomando acción</option><option value="resolved">Resuelta</option></select></label><label>Criticidad<select name="priority" value={priority} onChange={(event) => setPriority(event.target.value as AlertPriority)}><option value="urgent">Urgente</option><option value="high">Alta</option><option value="medium">Media</option><option value="low">Baja</option></select></label><label className="full">Comentario de seguimiento<textarea name="comment" required minLength={10} maxLength={500} rows={4} placeholder="Describe qué se revisó, qué acción está en curso o cómo se resolvió…" /></label><label className="full">Responsable<input value={userName} readOnly /></label></div>{status === "resolved" ? <div className="form-note warning"><span>!</span>Al guardar como resuelta, la alerta se cerrará definitivamente.</div> : <div className="form-note"><span>i</span>La alerta seguirá abierta y podrás agregar nuevos comentarios más adelante.</div>}{error && <div className="auth-error" role="alert"><span>!</span>{error}</div>}<div className="modal-actions"><button className="primary-button" type="submit" disabled={submitting}>{submitting ? "Guardando…" : status === "resolved" ? "Guardar comentario y resolver" : "Guardar seguimiento"}</button></div></form>}
    {canManage && alert.status === "resolved" && <div className="alert-resolved-note"><span>✓</span><div><strong>Alerta resuelta</strong><p>El cierre y todos sus comentarios permanecen disponibles para auditoría.</p></div></div>}
  </div>;
}

function PermanentDeleteConfirm({ name, type, onConfirm, onCancel }: { name: string; type: ManagedEntityType; onConfirm: () => void; onCancel: () => void }) {
  const labels: Record<ManagedEntityType, string> = { operators: "operador", equipment: "equipo", associations: "asociación" };
  return <div className="delete-confirm"><span className="danger-mark">!</span><ModalIntro eyebrow="Administración del proveedor" title="Eliminar definitivamente" detail={`Esta acción borrará el ${labels[type]} de la base local y no se puede deshacer.`} /><div className="delete-target"><small>REGISTRO SELECCIONADO</small><strong>{name}</strong></div><p>La eliminación sólo está permitida para registros archivados. Los operadores y equipos con asociaciones históricas se protegen hasta que esas relaciones sean eliminadas primero.</p><div className="modal-actions"><button type="button" className="secondary-button" onClick={onCancel}>Cancelar</button><button type="button" className="danger-button" onClick={onConfirm}>Eliminar de la base de datos</button></div></div>;
}

function RfidTagSchematic({ completed = false }: { completed?: boolean }) {
  return <div className={`rfid-tag-schematic ${completed ? "completed" : ""}`} aria-hidden="true">
    <svg viewBox="0 0 260 160" focusable="false">
      <defs>
        <linearGradient id="rfid-tag-gradient" x1="68" y1="30" x2="210" y2="137" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#a98ccb" />
          <stop offset="0.56" stopColor="#8062ad" />
          <stop offset="1" stopColor="#694a96" />
        </linearGradient>
        <linearGradient id="rfid-tag-ring" x1="112" y1="38" x2="208" y2="129" gradientUnits="userSpaceOnUse">
          <stop stopColor="#65468f" />
          <stop offset="1" stopColor="#3f2d5c" />
        </linearGradient>
        <filter id="rfid-tag-shadow" x="-35%" y="-35%" width="180%" height="190%">
          <feDropShadow dx="0" dy="8" stdDeviation="7" floodColor="#48325f" floodOpacity="0.2" />
        </filter>
      </defs>
      <ellipse className="rfid-tag-halo" cx="137" cy="82" rx="113" ry="67" />
      <g className="rfid-tag-illustration" filter="url(#rfid-tag-shadow)">
        <circle className="rfid-tag-loop" cx="42" cy="81" r="29" />
        <path className="rfid-tag-body" d="M69 53C98 36 127 20 159 20c41 0 72 26 75 59 3 35-24 63-61 66-34 3-65-14-98-35l-15-9c-16-10-18-28-5-40 4-3 8-6 14-8Z" />
        <ellipse className="rfid-tag-inner" cx="164" cy="81" rx="50" ry="51" />
        <path className="rfid-tag-glint" d="M87 49c22-12 45-21 69-22 27-1 50 11 62 30" />
        <path className="rfid-tag-hole-rim" d="M70 61c9 0 16 8 16 19s-7 20-16 20c-8 0-12-7-12-19 0-13 4-20 12-20Z" />
        <path className="rfid-tag-hole" d="M70 68c5 0 9 5 9 12 0 8-4 13-9 13-4 0-6-4-6-12 0-9 2-13 6-13Z" />
        {!completed && <g className="rfid-tag-signals">
          <path className="rfid-tag-wave wave-one" d="M148 80q16-19 32 0" />
          <path className="rfid-tag-wave wave-two" d="M139 70q25-29 50 0" />
          <path className="rfid-tag-wave wave-three" d="M130 60q34-39 68 0" />
        </g>}
        {completed && <g className="rfid-tag-check"><circle cx="164" cy="82" r="25" /><path d="m152 82 8 8 17-19" /></g>}
      </g>
    </svg>
  </div>;
}

function EnrollModal({ operatorId, operatorName, credentialIsMaster, onCompleted, onClose }: { operatorId: string | null; operatorName: string; credentialIsMaster: boolean; onCompleted: () => Promise<void>; onClose: () => void }) {
  const [seconds, setSeconds] = useState(300);
  const [commandId, setCommandId] = useState("");
  const [status, setStatus] = useState<"opening" | "approval" | "pending" | "reading" | "completed" | "failed">("opening");
  const [isMaster, setIsMaster] = useState(credentialIsMaster);
  const [currentMaster, setCurrentMaster] = useState<{ operatorName: string; credentialId: string } | null>(null);
  const [error, setError] = useState("");
  const onCompletedRef = useRef(onCompleted);
  useEffect(() => { onCompletedRef.current = onCompleted; }, [onCompleted]);
  const openEnrollment = useCallback(async (master: boolean, replaceMasterCredentialId?: string) => {
    setIsMaster(master); setStatus("opening"); setError(""); setCurrentMaster(null);
    try {
      const response = await fetch("/api/nfc-enrollment", {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(operatorId ? { operatorId } : {}), isMaster: master, replaceMasterCredentialId }),
      });
      const body = await response.json() as {
        command?: { id: string; expiresAt: string };
        error?: string;
        code?: string;
        currentMaster?: { operatorName: string; credentialId: string };
      };
      if (response.status === 409 && body.code === "MASTER_REPLACEMENT_REQUIRED" && body.currentMaster) {
        setCurrentMaster(body.currentMaster); setStatus("approval");
        return;
      }
      if (!response.ok || !body.command) throw new Error(body.error ?? "No fue posible abrir la ventana NFC.");
      setCommandId(body.command.id); setStatus("pending");
      setSeconds(Math.max(0, Math.floor((new Date(body.command.expiresAt).getTime() - Date.now()) / 1000)));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No fue posible abrir la ventana NFC."); setStatus("failed");
    }
  }, [operatorId]);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => { void openEnrollment(credentialIsMaster); });
    return () => window.cancelAnimationFrame(frame);
  }, [credentialIsMaster, openEnrollment]);
  useEffect(() => {
    if (!commandId || ["completed", "failed"].includes(status)) return;
    const poll = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/nfc-enrollment/${encodeURIComponent(commandId)}`, { credentials: "same-origin", cache: "no-store" });
        const body = await response.json() as { command?: { status: string; error?: string | null; expiresAt: string }; error?: string };
        if (!response.ok || !body.command) throw new Error(body.error ?? "No fue posible consultar el enrolamiento.");
        setSeconds(Math.max(0, Math.floor((new Date(body.command.expiresAt).getTime() - Date.now()) / 1000)));
        if (body.command.status === "completed") { setStatus("completed"); await onCompletedRef.current(); }
        else if (["failed", "expired", "cancelled"].includes(body.command.status)) { setStatus("failed"); setError(body.command.error ?? "La ventana de enrolamiento se cerró."); }
        else setStatus(body.command.status === "reading" ? "reading" : "pending");
      } catch (caught) { setError(caught instanceof Error ? caught.message : "Se perdió la comunicación con la Raspberry."); }
    }, 1000);
    return () => window.clearInterval(poll);
  }, [commandId, status]);
  const cancel = async () => {
    if (commandId && !["completed", "failed"].includes(status)) {
      await fetch(`/api/nfc-enrollment/${encodeURIComponent(commandId)}`, { method: "DELETE", credentials: "same-origin" }).catch(() => undefined);
    }
    onClose();
  };
  const minute = Math.floor(seconds / 60); const second = String(seconds % 60).padStart(2, "0");
  if (status === "approval" && currentMaster) return <div className="enroll-modal"><ModalIntro eyebrow="Aprobación requerida" title="Reemplazar tarjeta maestra" detail="Por diseño sólo puede existir una tarjeta maestra activa en el sistema." /><div className="master-replacement-warning" role="alert"><span>!</span><div><strong>La tarjeta anterior se desactivará</strong><p>{currentMaster.operatorName} · {currentMaster.credentialId}</p><small>Después de aprobar, esa tarjeta dejará de autorizar cargas. El cambio quedará registrado con tu usuario.</small></div></div><div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancelar</button><button type="button" className="danger-button" onClick={() => void openEnrollment(true, currentMaster.credentialId)}>Aprobar y enrolar la nueva</button></div></div>;
  return <div className="enroll-modal"><ModalIntro eyebrow={isMaster ? "Tarjeta maestra de emergencia" : "Enrolamiento RFID"} title={`Tag de ${operatorName}`} detail={status === "completed" ? `El tag quedó vinculado como ${isMaster ? "tarjeta maestra" : "credencial normal"} en la Raspberry.` : status === "reading" ? "La ventana de lectura está abierta en el validador del Fundo Santa Isabel." : "La Raspberry está preparando el validador del Fundo Santa Isabel."} /><div className="nfc-animation"><RfidTagSchematic completed={status === "completed"} /></div><h3>{status === "opening" ? "Abriendo el validador…" : status === "completed" ? "Tag enrolado correctamente" : status === "failed" ? "No se pudo completar" : status === "reading" ? "Validador listo; presenta el tag" : "Preparando el validador…"}</h3><p>{status === "completed" ? isMaster ? "Podrá autorizar cargas de emergencia sin un equipo válido; todas quedarán auditadas." : "Ya puedes usarlo en una autorización de carga normal." : status === "reading" ? "Acerca y mantén el tag. No lo retires hasta recibir confirmación." : "Espera a que aparezca “Validador listo” antes de acercar el tag."}</p>{error && <div className="auth-error" role="alert"><span>!</span>{error}</div>}{!["completed", "failed"].includes(status) && <div className="enroll-timer"><span>Ventana disponible</span><strong>{minute}:{second}</strong></div>}<div className="modal-actions centered"><button type="button" className={status === "completed" ? "primary-button" : "secondary-button"} onClick={cancel}>{status === "completed" ? "Listo" : "Cancelar enrolamiento"}</button></div></div>;
}

function CreateCredentialModal({ operators, credentials, onCompleted, onClose }: { operators: Operator[]; credentials: RfidCredential[]; onCompleted: () => Promise<void>; onClose: () => void }) {
  const [configuration, setConfiguration] = useState<{ operatorId: string | null; operatorName: string; isMaster: boolean } | null>(null);
  const [kind, setKind] = useState<"normal" | "master">("normal");
  const [error, setError] = useState("");
  const occupied = new Set(credentials.map((item) => item.operatorId).filter(Boolean));
  const eligibleOperators = operators.filter((item) => !item.archivedAt && item.active && !occupied.has(item.id));
  if (configuration) return <EnrollModal operatorId={configuration.operatorId} operatorName={configuration.operatorName} credentialIsMaster={configuration.isMaster} onCompleted={onCompleted} onClose={onClose} />;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const operatorId = String(data.get("operatorId") ?? "") || null;
    if (kind === "master" && !operatorId) { setError("La tarjeta maestra debe quedar vinculada a una persona responsable."); return; }
    const operator = operators.find((item) => item.id === operatorId);
    setConfiguration({ operatorId, operatorName: operator?.name ?? "Nueva credencial sin asignar", isMaster: kind === "master" });
  };
  return <form onSubmit={submit}><ModalIntro eyebrow="Nueva credencial RFID" title="Enrolar un tag" detail="Define el tipo al crear la credencial. Después podrás cambiar su operador desde Vinculaciones." /><div className="form-grid"><label className="full">Tipo de credencial<select name="kind" value={kind} onChange={(event) => setKind(event.target.value as "normal" | "master")}><option value="normal">Credencial normal</option><option value="master">Tarjeta maestra de emergencia</option></select></label><label className="full">Operador inicial<select name="operatorId" required={kind === "master"} defaultValue=""><option value="">Sin asignar por ahora</option>{eligibleOperators.map((item) => <option value={item.id} key={item.id}>{item.name} · {item.rut}</option>)}</select></label></div>{kind === "master" ? <div className="form-note warning"><span>!</span>Sólo puede existir una tarjeta maestra activa. Si ya hay una, deberás aprobar su reemplazo.</div> : <div className="form-note"><span>i</span>Una credencial normal sin operador queda inventariada, pero no autoriza cargas hasta ser vinculada.</div>}{error && <div className="auth-error modal-form-error" role="alert"><span>!</span>{error}</div>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancelar</button><button type="submit" className="primary-button">Abrir validador</button></div></form>;
}

function RfidAssignmentForm({ credentials, operators, initialCredentialId, onSubmit, onCancel }: { credentials: RfidCredential[]; operators: Operator[]; initialCredentialId?: string; onSubmit: (credentialId: string, operatorId: string | null) => Promise<void>; onCancel: () => void }) {
  const [credentialId, setCredentialId] = useState(initialCredentialId ?? credentials[0]?.credentialId ?? "");
  const [operatorId, setOperatorId] = useState(credentials.find((item) => item.credentialId === (initialCredentialId ?? credentials[0]?.credentialId))?.operatorId ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const selected = credentials.find((item) => item.credentialId === credentialId);
  const occupiedByOperator = new Map(credentials.filter((item) => item.operatorId).map((item) => [item.operatorId, item.credentialId]));
  const eligibleOperators = operators.filter((item) => !item.archivedAt && item.active && (!occupiedByOperator.has(item.id) || occupiedByOperator.get(item.id) === credentialId));
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setSubmitting(true); setError("");
    try { await onSubmit(credentialId, operatorId || null); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "No fue posible guardar la vinculación."); setSubmitting(false); }
  };
  const chooseCredential = (nextCredentialId: string) => {
    setCredentialId(nextCredentialId);
    setOperatorId(credentials.find((item) => item.credentialId === nextCredentialId)?.operatorId ?? "");
    setError("");
  };
  return <form onSubmit={submit}><ModalIntro eyebrow="Vinculación RFID · Operador" title="Asignar credencial" detail="Cada credencial y cada operador pueden participar en una sola vinculación." /><div className="association-form"><label>Credencial<select name="credentialId" value={credentialId} onChange={(event) => chooseCredential(event.target.value)} required>{credentials.map((item) => <option value={item.credentialId} key={item.credentialId}>{item.credentialId} · {item.credentialIsMaster ? "Maestra" : "Normal"}</option>)}</select></label><div className="association-form-link">↕</div><label>Operador<select name="operatorId" value={operatorId} onChange={(event) => setOperatorId(event.target.value)} required><option value="">Seleccionar operador</option>{eligibleOperators.map((item) => <option value={item.id} key={item.id}>{item.name} · {item.rut}</option>)}</select></label></div>{selected?.credentialIsMaster && <div className="form-note warning"><span>!</span>Esta vinculación entrega el privilegio de emergencia al operador seleccionado.</div>}{credentials.length === 0 && <div className="auth-error modal-form-error"><span>!</span>Primero enrola una credencial RFID.</div>}{error && <div className="auth-error modal-form-error" role="alert"><span>!</span>{error}</div>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={onCancel}>Cancelar</button><button className="primary-button" disabled={submitting || !credentialId || !operatorId}>{submitting ? "Guardando…" : "Guardar vinculación"}</button></div></form>;
}

function RfidDeleteConfirm({ credentialId, onConfirm, onCancel }: { credentialId: string; onConfirm: () => void; onCancel: () => void }) {
  return <div className="delete-confirm"><span className="danger-mark">!</span><ModalIntro eyebrow="Inventario RFID" title="Eliminar credencial" detail="La credencial se borrará de la base local y dejará de autorizar en la Raspberry." /><div className="delete-target"><small>TAG SELECCIONADO</small><strong>{credentialId}</strong></div><p>El tag físico no se destruye. Si vuelves a enrolarlo, podrá incorporarse nuevamente al inventario.</p><div className="modal-actions"><button type="button" className="secondary-button" onClick={onCancel}>Cancelar</button><button type="button" className="danger-button" onClick={onConfirm}>Eliminar de la base de datos</button></div></div>;
}

function IdentifyCredentialModal({ onClose }: { onClose: () => void }) {
  const [seconds, setSeconds] = useState(60);
  const [commandId, setCommandId] = useState("");
  const [status, setStatus] = useState<"opening" | "pending" | "reading" | "completed" | "failed">("opening");
  const [result, setResult] = useState<IdentifiedCredential | null>(null);
  const [error, setError] = useState("");
  const commandIdRef = useRef("");
  const finishedRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/nfc-identification", {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}",
    }).then(async (response) => {
      const body = await response.json() as { command?: { id: string; expiresAt: string }; error?: string };
      if (!response.ok || !body.command) throw new Error(body.error ?? "No fue posible abrir la identificación RFID.");
      if (!cancelled) {
        setCommandId(body.command.id);
        commandIdRef.current = body.command.id;
        setStatus("pending");
        setSeconds(Math.max(0, Math.floor((new Date(body.command.expiresAt).getTime() - Date.now()) / 1000)));
      }
    }).catch((caught) => {
      if (!cancelled) {
        setError(caught instanceof Error ? caught.message : "No fue posible abrir la identificación RFID.");
        setStatus("failed");
      }
    });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!commandId) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const response = await fetch(`/api/nfc-identification/${encodeURIComponent(commandId)}`, { credentials: "same-origin", cache: "no-store" });
        const body = await response.json() as { command?: { status: string; credentialId?: string | null; registered?: boolean; operator?: IdentifiedCredential["operator"]; error?: string | null; expiresAt: string }; error?: string };
        if (!response.ok || !body.command) throw new Error(body.error ?? "No fue posible consultar la identificación.");
        if (cancelled) return;
        setSeconds(Math.max(0, Math.floor((new Date(body.command.expiresAt).getTime() - Date.now()) / 1000)));
        if (body.command.status === "completed" && body.command.credentialId) {
          setResult({ credentialId: body.command.credentialId, registered: Boolean(body.command.registered), operator: body.command.operator ?? null });
          finishedRef.current = true;
          setStatus("completed");
        } else if (["failed", "expired", "cancelled"].includes(body.command.status)) {
          finishedRef.current = true;
          setStatus("failed");
          setError(body.command.error ?? "La ventana de identificación se cerró.");
        } else {
          setStatus(body.command.status === "reading" ? "reading" : "pending");
        }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Se perdió la comunicación con la Raspberry.");
      } finally {
        if (!cancelled && !finishedRef.current) timer = window.setTimeout(poll, 200);
      }
    };
    void poll();
    return () => { cancelled = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [commandId]);
  useEffect(() => () => {
    if (commandIdRef.current && !finishedRef.current) {
      void fetch(`/api/nfc-identification/${encodeURIComponent(commandIdRef.current)}`, { method: "DELETE", credentials: "same-origin" }).catch(() => undefined);
    }
  }, []);
  const close = async () => {
    if (commandId && !["completed", "failed"].includes(status)) {
      await fetch(`/api/nfc-identification/${encodeURIComponent(commandId)}`, { method: "DELETE", credentials: "same-origin" }).catch(() => undefined);
    }
    finishedRef.current = true;
    onClose();
  };
  const minute = Math.floor(seconds / 60);
  const second = String(seconds % 60).padStart(2, "0");
  const operatorState = result?.operator?.archivedAt ? "Operador archivado" : !result?.operator?.credentialActive ? "Credencial desactivada" : result?.operator?.credentialIsMaster ? "Tarjeta maestra activa" : result?.operator?.active ? "Operador activo" : "Operador inactivo";
  return <div className="enroll-modal identify-credential-modal"><ModalIntro eyebrow="Consulta RFID" title="Identificar tag" detail="La consulta autentica el tag y busca a su operador sin modificar ni enrolar datos." />{status === "completed" ? <div className={`identification-result ${result?.registered ? "registered" : "unregistered"}`}>{result?.operator ? <><span className="large-avatar">{initials(result.operator.name)}</span><div><small>TAG REGISTRADO</small><h3>{result.operator.name}</h3><p>{result.operator.rut}</p><strong className={result.operator.active && result.operator.credentialActive && !result.operator.archivedAt ? "active-text" : "muted-text"}><i />{operatorState}</strong></div></> : result?.registered ? <><span className="rfid-mini">⌁</span><div><small>TAG ENROLADO</small><h3>Sin operador asociado</h3><p>Está en el inventario RFID y disponible para vincular.</p></div></> : <><span className="identification-unknown">?</span><div><small>RESULTADO DE LA CONSULTA</small><h3>Tag no registrado</h3><p>No forma parte del inventario RFID del sistema.</p></div></>}</div> : <><div className="nfc-animation"><RfidTagSchematic /></div><h3>{status === "opening" ? "Abriendo el validador…" : status === "failed" ? "No se pudo identificar" : status === "reading" ? "Validador listo; presenta el tag" : "Preparando el validador…"}</h3><p>{status === "reading" ? "Apoya el tag centrado y déjalo quieto hasta escuchar la confirmación; no necesitas volver a presentarlo." : "Espera a que el validador confirme que está listo."}</p></>}{error && <div className="auth-error" role="alert"><span>!</span>{error}</div>}{!["completed", "failed"].includes(status) && <div className="enroll-timer"><span>Ventana disponible</span><strong>{minute}:{second}</strong></div>}{result && <code className="identified-credential-id">{result.credentialId}</code>}<div className="modal-actions centered"><button type="button" className={status === "completed" ? "primary-button" : "secondary-button"} onClick={close}>{status === "completed" ? "Listo" : "Cancelar identificación"}</button></div></div>;
}

function TransactionDetail({ item }: { item: Transaction }) {
  return <div><ModalIntro eyebrow="Detalle de carga" title={item.id} detail={`${item.time} · Fundo Santa Isabel`} /><div className="transaction-amount"><span>Volumen registrado</span><strong>{item.liters.toLocaleString("es-CL", { minimumFractionDigits: 1 })} <small>L</small></strong><StatusBadge status={item.status} /></div><dl className="detail-grid"><div><dt>Operador</dt><dd>{item.operator}</dd></div><div><dt>Equipo</dt><dd>{item.equipment}</dd></div><div><dt>Duración</dt><dd>{item.duration}</dd></div><div><dt>Validación</dt><dd>{item.validation}</dd></div><div><dt>Origen de dato</dt><dd>{item.source}</dd></div><div><dt>Persistencia</dt><dd className="success">Registrada por el edge</dd></div></dl></div>;
}

function EquipmentDetail({ item }: { item: Equipment }) {
  const expired = Boolean(item.assignmentExpired);
  return <div><ModalIntro eyebrow="Ficha de equipo" title={item.name} detail="Asignación local del módulo y el fundo" /><div className="equipment-detail-head"><span className="equipment-icon">{item.kind.slice(0, 2).toUpperCase()}</span><div><span className={`condition ${expired ? "expired" : item.condition.toLowerCase()}`}>{expired ? "Vencido" : item.condition}</span><strong>{expired ? "Carga bloqueada hasta revalidar" : item.active ? "Disponible para carga" : "Fuera de servicio"}</strong></div></div><dl className="detail-grid"><div><dt>Tipo</dt><dd>{item.kind}</dd></div><div><dt>Estado</dt><dd className={!expired && item.active ? "success" : ""}>{expired ? "Vencido" : item.active ? "Habilitado" : "Desactivado"}</dd></div><div><dt>Módulo</dt><dd>{item.module}</dd></div><div><dt>Vigencia en el fundo</dt><dd>{item.expiry ? formatAssignmentDate(item.expiry) : "Sin vencimiento"}</dd></div><div><dt>Fundo asignado</dt><dd>{item.siteId || "Sin asignación"}</dd></div></dl></div>;
}

function initials(name: string) {
  return name.split(" ").filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function formatArchivedDate(value: string) {
  const date = new Date(value.replace(" ", "T") + (value.includes("Z") ? "" : "Z"));
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("es-CL", { dateStyle: "medium" }).format(date);
}

function formatCompactDate(value: string) {
  const date = databaseInstant(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("es-CL", { dateStyle: "medium" }).format(date);
}

function formatAssignmentDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("es-CL", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function validChileanRut(value: string) {
  const compact = value.replace(/[.\s-]/gu, "").toUpperCase();
  if (!/^\d{7,8}[0-9K]$/u.test(compact)) return false;
  const digits = compact.slice(0, -1);
  let sum = 0; let multiplier = 2;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    sum += Number(digits[index]) * multiplier;
    multiplier = multiplier === 7 ? 2 : multiplier + 1;
  }
  const result = 11 - (sum % 11);
  const verifier = result === 11 ? "0" : result === 10 ? "K" : String(result);
  return verifier === compact.at(-1);
}

function mimSignalIsFresh(candidate: EnrollmentCandidate, nowMs: number) {
  const lastSeen = new Date(candidate.lastSeen).getTime();
  return nowMs > 0 && Number.isFinite(lastSeen) && nowMs >= lastSeen && nowMs - lastSeen <= 45_000;
}

function formatMimSignalAge(value: string, nowMs: number) {
  const instant = new Date(value).getTime();
  if (!Number.isFinite(instant) || nowMs <= 0) return "hora no disponible";
  const seconds = Math.max(0, Math.round((nowMs - instant) / 1000));
  if (seconds < 5) return "recibido ahora";
  if (seconds < 60) return `hace ${seconds} s`;
  return `hace ${Math.floor(seconds / 60)} min`;
}

function localDateTimeFromNow(days: number, minutes = 0) {
  const date = new Date(Date.now() + days * 24 * 60 * 60 * 1000 + minutes * 60 * 1000);
  date.setSeconds(0, 0);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60 * 1000);
  return local.toISOString().slice(0, 16);
}
