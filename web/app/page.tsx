"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import PowerSupplyView from "./power-supply-panel";
import { SystemWorkspace, SystemHealthPanel } from "./system-workspace";
import { isPowerAlert, powerIncidentLabels, type PowerIncidentType } from "../shared/power-supply";
import OcioCalibrationPanel from "./ocio-calibration-panel";
import { databaseInstant, formatSiteDate, siteDateKey, SITE_TIME_ZONE } from "./site-time";
import { fuelLevelDisplay } from "./fuel-level-display";
import { formatLiters, formatVolume, formatVolumeCsv, receiptVolumeToSave } from "../shared/volume-format";
import { InventoryBalancePanel } from "./inventory-balance-panel";
import { MachineFuelPanel } from "./machine-fuel-panel";
import { FuelTankGauge } from "./fuel-tank-gauge";
import { TANK_CAPACITY_LITERS } from "../shared/tank-capacity";

type ManagedEntityType = "operators" | "equipment" | "associations";
type EquipmentKind = "Tractor" | "Trilladora" | "Camión" | "Camioneta" | "Otro";
type EnrollmentAssignment = { name: string; kind: EquipmentKind; validUntil: string };

type View =
  | "overview"
  | "adoption"
  | "machineMap"
  | "transactions"
  | "fuelHistory"
  | "operators"
  | "rfidCredentials"
  | "equipment"
  | "mimEnrollment"
  | "associations"
  | "alerts"
  | "access"
  | "data"
  | "system";

type DataExportDataset = "all" | "voltages" | "machine-liters" | "levels" | "transactions" | "users" | "operators" | "equipment" | "associations" | "credentials" | "alerts";

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
  | { type: "equipmentRename"; id: string }
  | { type: "equipmentValidity"; id: string }
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

type CommissioningState = {
  siteId: string;
  status: "in_progress" | "completed";
  cycle: number;
  startedAt: string;
  completedAt: string | null;
  reopenedAt: string | null;
  reopenReason: string | null;
  updatedAt: string;
};

type RelayTestCommand = {
  id: string;
  transactionType: "pump_test";
  status: "pending" | "running" | "completed" | "failed" | "expired";
  durationSeconds: number;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  expiresAt: string;
  error: string | null;
};

type ManualModeSchedule = {
  id: string;
  actorUserId: string;
  actorRole: "master" | "administrator" | "supervisor";
  actorName: string;
  siteId: string;
  purpose: "manual" | "adoption_assisted";
  status: "scheduled" | "active" | "completed" | "cancelled" | "expired" | "failed";
  startAt: string;
  endAt: string;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
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
  eventType: "follow_up" | "reopened";
  statusAfter: AlertStatus;
  priorityAfter: AlertPriority;
  powerIncidentTypeAfter?: PowerIncidentType | null;
  recordedAt: string;
};
type AlertItem = {
  powerIncidentType?: PowerIncidentType | null;
  id: string;
  severity: "critical" | "warning" | "info";
  priority: AlertPriority;
  status: AlertStatus;
  title: string;
  detail: string;
  time: string;
  acknowledged: boolean;
  parentAlertId: string | null;
  rootAlertId: string;
  reopenNumber: number;
  reopenedAsAlertId: string | null;
  reopenedBy?: string | null;
  reopenReason?: string | null;
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
  status: "Completada" | "Interrumpida" | "Excepcional" | "Habilitación de bomba";
  validation: string;
  source: string;
  manualModeSessionId?: string | null;
};

type TransactionStatusFilter = "Todas" | Transaction["status"];

type FuelMovement = {
  id: string;
  type: "receipt" | "dispatch";
  classification: "standard" | "pump_enablement";
  occurredAt: string;
  liters: number;
  openingLevel: number;
  closingLevel: number;
  source: string;
  reference: string;
  legacyId?: string | null;
  manualModeSessionId?: string | null;
  detail: string;
  operatorId?: string | null;
  operatorName?: string | null;
  equipmentId?: string | null;
  equipmentName?: string | null;
  isMaster?: boolean;
  authorizationEvidence: "full" | "rfid_only" | "assisted" | "master" | "unauthorized" | "legacy";
  adoptionStage: TechnologyAdoptionStage | null;
  assistedMode: boolean;
  equipmentIssue: string | null;
  detectedAutomatically: boolean;
  confidence: number;
  status: "confirmed" | "accumulating";
  reviewStatus: "not_required" | "pending" | "approved" | "corrected" | "rejected";
  originalLiters: number | null;
  documentReference: string | null;
  reviewedByUserId: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
};

type FuelHistoryResponse = {
  movements: FuelMovement[];
  pendingReceipts: FuelMovement[];
  summary: { receivedLiters: number; dispatchedLiters: number; pumpEnablementLiters: number; netLiters: number; movementCount: number; pendingReceiptCount: number };
  sensor: { measurementQuality?: {occurredAt: string; status: string; telemetrySessionId?: string | null} | null; levelRange?: {minLiters: number; maxLiters: number} | null; capacityLiters: number; currentLevel: number; latestReadingAt: string; telemetrySessionId?: string | null; receiptThresholdLiters: number; acceptedVariationPercent: number; detectionStatus: "monitoring" | "warming_up" | "rising" | "detecting"; activeReceiptId: string | null; activeStartedAt: string | null; observedRiseLiters: number };
  edge: { moduleId: string; siteId: string; state: string; relayEnergized: boolean; validatorOnline: boolean; nfcReady: boolean; k24Enabled: boolean; k24Healthy: boolean; tankLevelEnabled: boolean; telemetrySessionId: string | null; technologyAdoptionStage: TechnologyAdoptionStage; adoptionPolicyRevision: number; occurredAt: string } | null;
};

type TechnologyAdoptionStage = "assisted" | "rfid_only" | "full";
type TechnologyAdoptionProgramStatus = "inactive" | "active" | "completed";
type TechnologyAdoptionDashboard = {
  settings: {
    siteId: string; stage: TechnologyAdoptionStage; programStatus: TechnologyAdoptionProgramStatus; revision: number;
    programStartedAt: string; completedAt: string | null; stageStartedAt: string; reviewAt: string | null;
    updatedBy: string | null; updatedByName: string | null; updatedAt: string; note: string;
  };
  metrics: {
    days: number; totalLoads: number; totalLiters: number;
    identifiedLoads: number; identifiedLiters: number; rfidCoverage: number;
    fullLoads: number; fullLiters: number; fullCoverage: number;
    assistedLoads: number; assistedLiters: number;
  };
  recommendation: { ready: boolean; title: string; detail: string };
  edgeApplication: { stage: TechnologyAdoptionStage | null; revision: number; occurredAt: string | null; applied: boolean } | null;
  history: { id: string; fromStage: TechnologyAdoptionStage; toStage: TechnologyAdoptionStage; reason: string; actorName: string; occurredAt: string }[];
};

type AuthUser = {
  name: string;
  role: string;
  roleCode: string;
  permissions: Permission[];
  mustChangePassword: boolean;
};

type Permission = "view_dashboard" | "view_transactions" | "manage_receipts" | "manage_alerts" | "manage_operators" | "manage_equipment" | "manage_associations" | "manage_users" | "manage_system";
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

const SITE_VERSION = "V.1.9.29";

const releaseNotes = [
  { title: "Avisos de inventario confirmados", detail: "Los descensos se verifican antes de avisar y sus antecedentes se agrupan en un incidente." },
  { title: "Comparación entre días", detail: "Seguimiento frente al día anterior, hace tres y siete días, conservando la referencia conciliada." },
] as const;

const seedOperators: Operator[] = [];

const seedEquipment: Equipment[] = [];

const initialTransactions: Transaction[] = [];

const seedAssociations: Association[] = [];

const seedAlerts: AlertItem[] = [];

const navItems: { id: View; label: string; short: string; group: "operate" | "manage" | "support" }[] = [
  { id: "overview", label: "Resumen", short: "RE", group: "operate" },
  { id: "fuelHistory", label: "Histórico de combustible", short: "HC", group: "operate" },
  { id: "transactions", label: "Cargas", short: "CA", group: "operate" },
  { id: "alerts", label: "Alertas", short: "AL", group: "operate" },
  { id: "adoption", label: "Adopción tecnológica", short: "AT", group: "operate" },
  { id: "operators", label: "Operadores", short: "OP", group: "manage" },
  { id: "equipment", label: "Equipos", short: "EQ", group: "manage" },
  { id: "associations", label: "Asociaciones", short: "AS", group: "manage" },
  { id: "access", label: "Usuarios", short: "US", group: "support" },
  { id: "data", label: "Data", short: "DT", group: "support" },
  { id: "system", label: "Sistema", short: "SI", group: "support" },
];

const viewCopy: Record<View, { eyebrow: string; title: string }> = {
  overview: { eyebrow: "Operación local", title: "Fundo Santa Isabel" },
  adoption: { eyebrow: "Transformación en terreno", title: "Adopción tecnológica" },
  machineMap: { eyebrow: "Activos · Equipos abastecibles", title: "Mapa de máquinas" },
  transactions: { eyebrow: "Trazabilidad", title: "Cargas de combustible" },
  fuelHistory: { eyebrow: "Inventario y trazabilidad", title: "Histórico de combustible" },
  operators: { eyebrow: "Personas", title: "Operadores" },
  rfidCredentials: { eyebrow: "Personas · Operadores", title: "Credenciales RFID" },
  equipment: { eyebrow: "Activos", title: "Equipos abastecibles" },
  mimEnrollment: { eyebrow: "Activos · Equipos abastecibles", title: "Enlazar nuevo MIM" },
  associations: { eyebrow: "Autorizaciones", title: "Asociaciones vigentes" },
  alerts: { eyebrow: "Supervisión", title: "Alertas" },
  access: { eyebrow: "Seguridad", title: "Usuarios y permisos" },
  data: { eyebrow: "Soporte · Datos", title: "Data" },
  system: { eyebrow: "Infraestructura", title: "Salud del sistema" },
};

const adoptionStageCopy: Record<TechnologyAdoptionStage, { number: number; short: string; title: string; detail: string; benefit: string }> = {
  assisted: { number: 1, short: "Aprendizaje", title: "Aprendizaje asistido", detail: "La faena continúa dentro de una ventana aprobada mientras el equipo practica RFID y MIM.", benefit: "Aprender sin detener la operación" },
  rfid_only: { number: 2, short: "Identidad RFID", title: "Identidad RFID", detail: "Un tag vigente y mantenido identifica al operador; el MIM agrega evidencia cuando está disponible.", benefit: "Responsable identificado en cada carga" },
  full: { number: 3, short: "Integrada", title: "Trazabilidad completa", detail: "RFID, MIM, asociación y fundo forman la evidencia mínima de autorización.", benefit: "Operador y máquina completamente validados" },
};

const adoptionStages: TechnologyAdoptionStage[] = ["assisted", "rfid_only", "full"];

export default function Home() {
  const [auth, setAuth] = useState<AuthState>({ status: "checking" });
  const [authError, setAuthError] = useState("");
  const [view, setView] = useState<View>("overview");
  const [menuOpen, setMenuOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [whatsNewOpen, setWhatsNewOpen] = useState(false);
  const profileWrapRef = useRef<HTMLDivElement | null>(null);
  const whatsNewWrapRef = useRef<HTMLDivElement | null>(null);
  const [search, setSearch] = useState("");
  const [transactionStatus, setTransactionStatus] = useState<TransactionStatusFilter>("Completada");
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
  const [adoption, setAdoption] = useState<TechnologyAdoptionDashboard | null>(null);
  const [adoptionLoading, setAdoptionLoading] = useState(false);
  const [entityError, setEntityError] = useState("");
  const [entitiesLoading, setEntitiesLoading] = useState(false);
  const [rfidLoading, setRfidLoading] = useState(false);
  const [clock, setClock] = useState("");
  const [nowMs, setNowMs] = useState(0);
  const [exportingDataset, setExportingDataset] = useState<DataExportDataset | null>(null);

  const refreshEntities = useCallback(async () => {
    const response = await fetch("/api/managed-entities", { credentials: "same-origin", cache: "no-store" });
    const body = await response.json() as { operators?: Operator[]; equipment?: Equipment[]; associations?: Association[]; error?: string };
    if (!response.ok || !body.operators || !body.equipment || !body.associations) throw new Error(body.error ?? "No fue posible cargar los registros.");
    setOperators(body.operators.map((item) => ({ ...item, credential: formatCredentialId(item.credential) })));
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
  const refreshAdoption = useCallback(async () => {
    const response = await fetch("/api/technology-adoption", { credentials: "same-origin", cache: "no-store" });
    const body = await response.json() as TechnologyAdoptionDashboard & { error?: string };
    if (!response.ok || !body.settings) throw new Error(body.error ?? "No fue posible cargar la adopción tecnológica.");
    // An older polling request must not restore an active program after closing it.
    setAdoption(current => current && current.settings.revision > body.settings.revision ? current : body);
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
      setAdoptionLoading(true);
      Promise.all([refreshAlerts(), refreshTransactions(), refreshAdoption()]).catch((error: unknown) => setEntityError(error instanceof Error ? error.message : "No fue posible cargar la operación."))
        .finally(() => setAdoptionLoading(false));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [auth.status, refreshAdoption, refreshAlerts, refreshTransactions]);

  useEffect(() => {
    if (auth.status !== "signed-in" || !["overview", "equipment", "mimEnrollment"].includes(view) || !auth.user.permissions.includes("manage_equipment")) return;
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
        refreshAdoption(),
      ]).catch(() => undefined).finally(() => { refreshing = false; });
    };
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => window.clearInterval(timer);
  }, [auth.status, refreshAdoption, refreshAlerts, refreshOperationalStatus, refreshTransactions]);

  useEffect(() => {
    if (view !== "adoption" || !adoption || adoption.settings.programStatus === "active") return;
    const canOpenSystem = auth.status === "signed-in"
      && (auth.user.permissions.includes("manage_system") || ["master", "administrator", "supervisor"].includes(auth.user.roleCode));
    const frame = window.requestAnimationFrame(() => setView(canOpenSystem ? "system" : "overview"));
    return () => window.cancelAnimationFrame(frame);
  }, [adoption, auth, view]);

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
          timeZone: SITE_TIME_ZONE,
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

  useEffect(() => {
    const closeHeaderMenus = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setWhatsNewOpen(false);
      setProfileOpen(false);
    };
    window.addEventListener("keydown", closeHeaderMenus);
    return () => window.removeEventListener("keydown", closeHeaderMenus);
  }, []);

  useEffect(() => {
    if (!profileOpen && !whatsNewOpen) return;
    const closeHeaderMenusOutside = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (!profileWrapRef.current?.contains(event.target)) setProfileOpen(false);
      if (!whatsNewWrapRef.current?.contains(event.target)) setWhatsNewOpen(false);
    };
    document.addEventListener("pointerdown", closeHeaderMenusOutside);
    return () => document.removeEventListener("pointerdown", closeHeaderMenusOutside);
  }, [profileOpen, whatsNewOpen]);

  useEffect(() => () => {
    if (networkScanTimer.current !== null) window.clearTimeout(networkScanTimer.current);
  }, []);

  const openView = (next: View) => {
    setView(next);
    setSearch("");
    if (next === "transactions") setTransactionStatus("Completada");
    setMenuOpen(false);
    setWhatsNewOpen(false);
  };

  const visibleTransactions = transactions.filter((item) => {
    const matchesSearch = `${item.id} ${item.operator} ${item.equipment}`.toLowerCase().includes(search.toLowerCase());
    const matchesStatus = transactionStatus === "Todas" || item.status === transactionStatus;
    return matchesSearch && matchesStatus;
  });

  const downloadCsv = (items: Transaction[] = transactions) => {
    const header = "ID,Sesión manual,Fecha,Operador,Equipo,Litros,Duración,Estado,Validación";
    const rows = items.map((item) =>
      [item.id, item.manualModeSessionId ?? "", item.time, item.operator, item.equipment, formatVolumeCsv(item.liters), item.duration, item.status, item.validation]
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

  const downloadDatabase = async (dataset: DataExportDataset) => {
    setExportingDataset(dataset);
    setEntityError("");
    try {
      const response = await fetch(`/api/data-export?dataset=${encodeURIComponent(dataset)}`, { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) {
        const body = await response.json() as { error?: string };
        throw new Error(body.error ?? "No fue posible preparar la exportación.");
      }
      const disposition = response.headers.get("content-disposition") ?? "";
      const filename = /filename="([^"]+)"/u.exec(disposition)?.[1] ?? "base-datos-fundo-santa-isabel.json";
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setToast(dataset === "all" ? "Base operacional exportada correctamente" : "Conjunto de datos exportado correctamente");
    } catch (error) {
      setEntityError(error instanceof Error ? error.message : "No fue posible preparar la exportación.");
    } finally {
      setExportingDataset(null);
    }
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
    setToast("Asignación enviada. El PLC la entregará al MIM por la red Wi-Fi local.");
    await refreshEnrollment();
  };

  const requestEquipmentScan = async () => {
    try {
      await refreshEnrollment();
      setToast("Lista actualizada. Los MIM nuevos aparecen automáticamente al conectarse al PLC.");
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
    try { await managedRequest(type, "DELETE", undefined, id); setModal(null); setToast(type === "equipment" ? "Equipo eliminado; la identidad del MIM queda disponible para volver a enrolar" : "Registro eliminado definitivamente de la base local"); }
    catch (error) { setEntityError(error instanceof Error ? error.message : "No fue posible eliminar el registro."); setModal(null); }
  };
  const renameEquipment = async (id: string, name: string) => {
    await managedRequest("equipment", "PATCH", { name }, id);
    setModal({ type: "equipmentDetail", id });
    setToast("Nombre del equipo actualizado");
  };
  const modifyEquipmentValidity = async (id: string, expiry: string) => {
    await managedRequest("equipment", "PATCH", { expiry }, id);
    setModal({ type: "equipmentDetail", id });
    setToast("Período de validez actualizado");
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
  const updateAlert = async (alertId: string, update: { description: string; status: AlertStatus; priority: AlertPriority; powerIncidentType?: PowerIncidentType | null }) => {
    const response = await fetch(`/api/alerts/${encodeURIComponent(alertId)}/action`, {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update),
    });
    const body = await response.json() as { updated?: boolean; resolved?: boolean; error?: string };
    if (!response.ok || !body.updated) throw new Error(body.error ?? "No fue posible registrar el seguimiento.");
    await refreshAlerts();
    setToast(body.resolved ? "Seguimiento registrado y alerta resuelta" : "Seguimiento agregado; la alerta continúa abierta");
  };
  const reopenAlert = async (alertId: string, update: { reason: string; priority: AlertPriority }) => {
    const response = await fetch(`/api/alerts/${encodeURIComponent(alertId)}/reopen`, {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update),
    });
    const body = await response.json() as { reopened?: boolean; alertId?: string; reopenNumber?: number; error?: string };
    if (!response.ok || !body.reopened || !body.alertId) throw new Error(body.error ?? "No fue posible reabrir la alerta.");
    await refreshAlerts();
    setModal({ type: "alertDetail", alertId: body.alertId });
    setToast(`Alerta reabierta como ciclo ${body.reopenNumber ?? 1}; quedó pendiente de atención`);
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
  const expiringEquipment = equipment.filter((item) => !item.archivedAt && assignmentExpiresWithin24Hours(item, nowMs));
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
    setWhatsNewOpen(false);
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
  const adoptionActive = adoption?.settings.programStatus === "active";
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
      <Sidebar view={view} open={menuOpen} edgeOnline={edgeOnline} validatorConnected={validatorConnected} alertCount={pendingAlerts} permissions={currentUser.permissions} roleCode={currentUser.roleCode} adoptionActive={adoptionActive} onNavigate={openView} onClose={() => setMenuOpen(false)} />

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
            {adoptionActive && <TechnologyAdoptionTag dashboard={adoption} loading={adoptionLoading} onOpen={() => openView("adoption")} />}
          </div>
          <div className="topbar-center" aria-label="Estado de conexión">
            <span className={`online-dot ${validatorConnected ? "" : "offline"}`} /> <strong>{validatorConnected ? "Validador conectado" : "Validador no conectado"}</strong><span className="topbar-edge-state">{edgeOnline ? "Edge en línea" : "Edge sin reporte"}</span><span className="topbar-time">{clock}</span>
          </div>
          <div className="topbar-actions">
            <div className="whats-new-wrap" ref={whatsNewWrapRef}>
              <button className="whats-new-button" type="button" aria-label="Novedades de la actualización" aria-expanded={whatsNewOpen} aria-controls="whats-new-panel" onClick={() => { setWhatsNewOpen(!whatsNewOpen); setProfileOpen(false); }}>
                <span className="whats-new-icon" aria-hidden="true">✦</span><span className="whats-new-label">Novedades</span>
              </button>
              {whatsNewOpen && (
                <section id="whats-new-panel" className="whats-new-panel" aria-label={`Novedades de ${SITE_VERSION}`}>
                  <div className="whats-new-heading"><div><span>ACTUALIZACIÓN ACTUAL</span><strong>{SITE_VERSION}</strong></div><time dateTime="2026-09-17">17 SEP 2026</time></div>
                  <ol>{releaseNotes.map((note) => <li key={note.title}><span aria-hidden="true">✓</span><div><strong>{note.title}</strong><p>{note.detail}</p></div></li>)}</ol>
                </section>
              )}
            </div>
            <button className="icon-button notification-button" type="button" aria-label={`${pendingAlerts} alertas pendientes`} onClick={() => openView("alerts")}>
              <span aria-hidden="true">!</span>{pendingAlerts > 0 && <b>{formatAlertBadge(pendingAlerts)}</b>}
            </button>
            <div className="profile-wrap" ref={profileWrapRef}>
              <button className="profile-button" type="button" aria-expanded={profileOpen} aria-controls="profile-menu" onClick={() => { setProfileOpen(!profileOpen); setWhatsNewOpen(false); }}>
                <span className="avatar">PC</span><span className="profile-copy"><strong>{currentUser.name}</strong><small>{currentUser.role}</small></span><span className="chevron">⌄</span>
              </button>
              {profileOpen && (
                <div id="profile-menu" className="profile-menu">
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
            <div><span className="eyebrow">{currentCopy.eyebrow}</span><h1>{currentCopy.title}</h1></div>
            <ViewActions view={view} permissions={currentUser.permissions} isProviderAdmin={currentUser.roleCode === "master"} onNavigate={openView} onModal={setModal} onExport={() => downloadCsv(visibleTransactions)} exportDisabled={visibleTransactions.length === 0} />
          </section>

          {entityError && <div className="auth-error content-error" role="alert"><span>!</span>{entityError}</div>}
          {expiringEquipment.length > 0 && <section className="expiry-alerts" aria-label="MIM próximos a caducar">{expiringEquipment.map((item) => <div className="expiry-alert panel" role="alert" key={item.id}><span aria-hidden="true">!</span><div><strong>MIM {item.module} por caducar en 24 horas</strong><small>{item.name} · vigente hasta el {item.expiry ? formatAssignmentDate(item.expiry) : "—"}</small></div><button className="text-button" type="button" onClick={() => openView("equipment")}>Revisar vigencia</button></div>)}</section>}
          {(entitiesLoading && ["operators", "equipment", "associations"].includes(view) || rfidLoading && view === "rfidCredentials") && <div className="panel entity-loading" role="status">Cargando registros locales…</div>}

          {view === "overview" && <Overview alerts={alerts} transactions={transactions} sensor={fuelSensor} edge={edgeStatus} edgeOnline={edgeOnline} equipment={equipment} adoption={adoptionActive ? adoption : null} nowMs={nowMs} canViewFuelHistory={currentUser.permissions.includes("view_transactions")} canScanNetwork={currentUser.permissions.includes("manage_equipment")} networkScanState={networkScanState} onNetworkScan={startNetworkScan} onNavigate={openView} onTransaction={(id) => setModal({ type: "transaction", id })} />}
          {view === "adoption" && adoptionActive && <TechnologyAdoptionView key={`${adoption.settings.revision}-${adoption.settings.updatedAt}`} dashboard={adoption} loading={adoptionLoading} edge={edgeStatus} online={edgeOnline} roleCode={currentUser.roleCode} permissions={currentUser.permissions} onRefresh={async () => { await Promise.all([refreshAdoption(), refreshOperationalStatus(), refreshTransactions()]); }} />}
          {view === "machineMap" && <MachineMap observations={machineObservations} validatorConnected={validatorConnected} nowMs={nowMs} />}
          {view === "transactions" && <Transactions search={search} status={transactionStatus} items={visibleTransactions} allItems={transactions} edge={edgeStatus} edgeOnline={edgeOnline} onSearch={setSearch} onStatus={setTransactionStatus} onExport={() => downloadCsv(visibleTransactions)} onOpen={(id) => setModal({ type: "transaction", id })} />}
          {view === "fuelHistory" && <FuelHistoryView nowMs={nowMs} canManageReceipts={currentUser.permissions.includes("manage_receipts")} />}
          {view === "operators" && !entitiesLoading && <Operators operators={operators} search={search} isProviderAdmin={currentUser.roleCode === "master"} onSearch={setSearch} onToggle={(item) => updateManaged("operators", item.id, { active: !item.active }, "Estado del operador actualizado")} onArchive={(item, archived) => updateManaged("operators", item.id, { archived }, archived ? "Operador enviado al histórico" : "Operador restaurado")} onDelete={(item) => setModal({ type: "permanentDelete", entityType: "operators", id: item.id, name: item.name })} onReplace={(item) => setModal({ type: "enroll", operatorId: item.id, operatorName: item.name, credentialIsMaster: item.credentialIsMaster })} onCredentials={() => openView("rfidCredentials")} />}
          {view === "rfidCredentials" && !rfidLoading && <RfidCredentialsView credentials={rfidCredentials} operators={operators} isProviderAdmin={currentUser.roleCode === "master"} onIdentify={() => setModal({ type: "identifyCredential" })} onCreate={() => setModal({ type: "createCredential" })} onAssign={(credentialId) => setModal({ type: "rfidAssignment", credentialId })} onUnassign={(credentialId) => void unassignRfid(credentialId)} onDelete={(credentialId) => setModal({ type: "deleteCredential", credentialId })} />}
          {view === "equipment" && !entitiesLoading && <EquipmentView equipment={equipment} candidates={enrollmentCandidates} search={search} nowMs={nowMs} onSearch={setSearch} onOpen={(id) => setModal({ type: "equipmentDetail", id })} />}
          {view === "mimEnrollment" && <MimEnrollmentView candidates={enrollmentCandidates} scan={equipmentScan} nowMs={nowMs} onEnroll={(moduleId) => setModal({ type: "equipmentEnrollment", moduleId })} onRefresh={requestEquipmentScan} />}
          {view === "associations" && !entitiesLoading && <AssociationsView associations={associations} operators={operators} equipment={equipment} isProviderAdmin={currentUser.roleCode === "master"} onToggle={(item) => updateManaged("associations", item.id, { active: !item.active }, "Asociación actualizada")} onArchive={(item, archived) => updateManaged("associations", item.id, { archived }, archived ? "Asociación enviada al histórico" : "Asociación restaurada")} onDelete={(item, name) => setModal({ type: "permanentDelete", entityType: "associations", id: item.id, name })} />}
          {view === "alerts" && <AlertsView alerts={alerts} canManage={currentUser.permissions.includes("manage_alerts")} onOpen={(id) => setModal({ type: "alertDetail", alertId: id })} />}
          {view === "access" && currentUser.permissions.includes("manage_users") && <AccessView canDeleteUsers={currentUser.roleCode === "master"} />}
          {view === "data" && <DataExportView exporting={exportingDataset} onExport={downloadDatabase} />}
          {view === "system" && <SystemView powerRevision={alerts.filter(isPowerAlert).map(item => item.id + (item.powerIncidentType ?? "")).join("|")} onOpenAlert={(alertId) => setModal({ type: "alertDetail", alertId })} nowMs={nowMs} edge={edgeStatus} sensor={fuelSensor} adoption={adoption} adoptionLoading={adoptionLoading} online={edgeOnline} canManage={currentUser.permissions.includes("manage_system")} canManageCommissioning={currentUser.roleCode === "master" && currentUser.permissions.includes("manage_system")} canManageAdoption={["master", "administrator"].includes(currentUser.roleCode) && currentUser.permissions.includes("manage_system")} canManageManualMode={["master", "administrator", "supervisor"].includes(currentUser.roleCode)} canTestPump={["master", "administrator"].includes(currentUser.roleCode) && currentUser.permissions.includes("manage_system")} onRefresh={refreshOperationalStatus} onRefreshAdoption={async () => { await Promise.all([refreshAdoption(), refreshOperationalStatus()]); }} onOpenAdoption={() => openView("adoption")} onReset={resetFuelData} />}
        </main>
      </div>

      {modal && <ModalLayer modal={modal} alerts={alerts} transactions={transactions} operators={operators} rfidCredentials={rfidCredentials} equipment={equipment} candidates={enrollmentCandidates} userName={currentUser.name} canManageAlerts={currentUser.permissions.includes("manage_alerts")} isProviderAdmin={currentUser.roleCode === "master"} onClose={() => setModal(null)} onAddOperator={createOperator} onAddEquipment={(item) => createManaged("equipment", item, "Equipo creado correctamente")} onAddAssociation={(item) => createManaged("associations", item, "Asociación creada y vigente")} onShowEquipment={(id) => setModal({ type: "equipmentDetail", id })} onEditEquipment={(id) => setModal({ type: "equipmentRename", id })} onEditEquipmentValidity={(id) => setModal({ type: "equipmentValidity", id })} onToggleEquipment={(item) => updateManaged("equipment", item.id, { active: !item.active }, "Estado del equipo actualizado")} onArchiveEquipment={(item, archived) => updateManaged("equipment", item.id, { archived }, archived ? "Equipo enviado al histórico" : "Equipo restaurado")} onDeleteEquipment={(item) => setModal({ type: "permanentDelete", entityType: "equipment", id: item.id, name: item.name })} onRevalidateEquipment={(moduleId) => setModal({ type: "equipmentEnrollment", moduleId })} onRenameEquipment={renameEquipment} onModifyEquipmentValidity={modifyEquipmentValidity} onEnrollEquipment={enrollEquipment} onNfcEnrolled={async () => { await Promise.all([refreshEntities(), refreshRfidCredentials()]); setToast("Credencial RFID enrolada y sincronizada con el PLC"); }} onAssignRfid={assignRfid} onDeleteRfid={deleteRfid} onPermanentDelete={permanentlyDelete} onUpdateAlert={updateAlert} onReopenAlert={reopenAlert} onOpenAlert={(alertId) => setModal({ type: "alertDetail", alertId })} />}
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
  return <main className="auth-shell"><section className="auth-card"><div className="auth-brand"><span className="auth-mark">CT</span><div><strong>Concha y Toro -</strong><span>Monitoreo Combustible</span></div></div><div className="auth-copy"><span className="eyebrow">Fundo Santa Isabel</span><h1>Acceso al sistema</h1><p>Ingresa con tu cuenta autorizada para consultar y administrar la operación local.</p></div><form className="auth-form" onSubmit={submit}><label>Correo electrónico<input name="email" type="email" autoComplete="username" required placeholder="nombre@empresa.cl" /></label><label>Contraseña<input name="password" type="password" autoComplete="current-password" required minLength={10} /></label><button className="auth-link" type="button" onClick={() => setRecovering(true)}>¿Olvidaste tu contraseña?</button>{error && <div className="auth-error" role="alert"><span>!</span>{error}</div>}<button className="primary-button" type="submit" disabled={submitting}>{submitting ? "Verificando…" : "Iniciar sesión"}</button></form><AuthVersion /></section><AuthSide /></main>;
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
  return <main className="auth-shell"><section className="auth-card"><div className="auth-brand"><span className="auth-mark">CT</span><div><strong>Recuperación segura</strong><span>Fundo Santa Isabel</span></div></div>{success ? <div className="auth-copy recovery-success"><span className="security-mark">✓</span><h1>Contraseña actualizada</h1><p>Ya puedes iniciar sesión con la nueva contraseña.</p><button className="primary-button" onClick={onBack}>Volver al inicio</button></div> : <><div className="auth-copy"><span className="eyebrow">CUENTA MAESTRA</span><h1>Recuperar acceso</h1><p>Utiliza el código de recuperación guardado fuera del PLC al aprovisionar el sistema.</p></div><form className="auth-form" onSubmit={submit}><label>Correo maestro<input name="email" type="email" autoComplete="username" required /></label><label>Código de recuperación<input name="recoveryCode" autoComplete="off" required placeholder="XXXX-XXXX-XXXX-XXXX-XXXX" /></label><label>Nueva contraseña<input name="newPassword" type="password" autoComplete="new-password" required minLength={12} /></label><label>Repetir nueva contraseña<input name="confirmation" type="password" autoComplete="new-password" required minLength={12} /></label>{error && <div className="auth-error" role="alert"><span>!</span>{error}</div>}<button className="primary-button" disabled={submitting}>{submitting ? "Actualizando…" : "Cambiar contraseña"}</button><button className="auth-link centered" type="button" onClick={onBack}>Volver al inicio de sesión</button></form></>}<AuthVersion /></section><AuthSide recovery /></main>;
}

function PasswordChangeScreen({ user, onChange, onLogout }: { user: AuthUser; onChange: (password: string) => Promise<void>; onLogout: () => Promise<void> }) {
  const [error, setError] = useState(""); const [submitting, setSubmitting] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); const password = String(form.get("password")); if (password !== String(form.get("confirmation"))) { setError("Las contraseñas no coinciden."); return; } setSubmitting(true); setError(""); try { await onChange(password); } catch (caught) { setError(caught instanceof Error ? caught.message : "No fue posible cambiar la contraseña."); setSubmitting(false); } };
  return <main className="auth-shell"><section className="auth-card"><div className="auth-brand"><span className="auth-mark">{initials(user.name)}</span><div><strong>{user.name}</strong><span>Primer acceso</span></div></div><div className="auth-copy"><span className="eyebrow">PROTECCIÓN DE CUENTA</span><h1>Crea tu contraseña definitiva</h1><p>La clave temporal sólo sirve para este primer ingreso.</p></div><form className="auth-form" onSubmit={submit}><label>Nueva contraseña<input name="password" type="password" autoComplete="new-password" required minLength={12} /></label><label>Repetir contraseña<input name="confirmation" type="password" autoComplete="new-password" required minLength={12} /></label><small className="password-rules">Mínimo 12 caracteres, con mayúscula, minúscula, número y símbolo.</small>{error && <div className="auth-error" role="alert"><span>!</span>{error}</div>}<button className="primary-button" disabled={submitting}>{submitting ? "Guardando…" : "Guardar y continuar"}</button><button className="auth-link centered" type="button" onClick={onLogout}>Cerrar sesión</button></form><AuthVersion /></section><AuthSide /></main>;
}

function AuthVersion() {
  return <small className="auth-version">© 2026 by KronTec · {SITE_VERSION}</small>;
}

function AuthSide({ recovery = false }: { recovery?: boolean }) {
  return <aside className="auth-side"><div><span className="eyebrow">OPERACIÓN LOCAL</span><h2>{recovery ? "Recuperación controlada, sin depender de Internet." : "Control y trazabilidad de petróleo en línea."}</h2></div></aside>;
}

function TechnologyAdoptionTag({ dashboard, loading, onOpen }: { dashboard: TechnologyAdoptionDashboard | null; loading: boolean; onOpen: () => void }) {
  const stage = dashboard?.settings.stage ?? "full";
  const copy = adoptionStageCopy[stage];
  return <button className={`adoption-site-tag stage-${stage}`} type="button" onClick={onOpen} aria-label={`Abrir adopción tecnológica: ${copy.title}`}>
    <span className="adoption-tag-mark">{loading && !dashboard ? "·" : copy.number}</span>
    <span><small>ADOPCIÓN TECNOLÓGICA</small><strong>{loading && !dashboard ? "Consultando…" : copy.short}</strong></span>
  </button>;
}

function TechnologyAdoptionView({ dashboard, loading, edge, online, roleCode, permissions, onRefresh }: { dashboard: TechnologyAdoptionDashboard | null; loading: boolean; edge: FuelHistoryResponse["edge"]; online: boolean; roleCode: string; permissions: Permission[]; onRefresh: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [stage, setStage] = useState<TechnologyAdoptionStage>(dashboard?.settings.stage ?? "full");
  const [reviewAt, setReviewAt] = useState(dashboard?.settings.reviewAt ? dateTimeLocalValue(new Date(dashboard.settings.reviewAt)) : "");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  if (!dashboard) return <div className="panel adoption-loading" role="status">{loading ? "Cargando la ruta de adopción…" : "La ruta de adopción todavía no está disponible."}</div>;
  const current = dashboard.settings.stage;
  const currentIndex = adoptionStages.indexOf(current);
  const copy = adoptionStageCopy[current];
  const canManageStage = ["master", "administrator"].includes(roleCode) && permissions.includes("manage_system");
  const canSchedule = ["master", "administrator", "supervisor"].includes(roleCode);
  const allowedStages = adoptionStages.filter((_, index) => Math.abs(index - currentIndex) <= 1);
  const operatorSteps = current === "assisted"
    ? ["Pulsa el botón del MIM para despertar la máquina.", "Presenta y mantén tu tag RFID en el validador.", "Espera la confirmación y comienza la carga."]
    : current === "rfid_only"
      ? ["Presenta y mantén tu tag RFID.", "Espera la confirmación del operador.", "Pulsa el MIM cuando esté disponible para sumar trazabilidad completa."]
      : ["Pulsa el botón del MIM.", "Presenta y mantén tu tag RFID.", "Espera la confirmación de operador, máquina y asociación."];

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setSaving(true); setError("");
    try {
      const response = await fetch("/api/technology-adoption", {
        method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage, reviewAt: reviewAt ? new Date(reviewAt).toISOString() : null, note }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "No fue posible actualizar la etapa.");
      setEditing(false); setNote(""); await onRefresh();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "No fue posible actualizar la etapa."); }
    finally { setSaving(false); }
  };

  return <div className="adoption-layout">
    <section className={`panel adoption-hero stage-${current}`}>
      <div className="adoption-hero-copy"><span className="eyebrow">ETAPA {copy.number} DE 3 · FUNDO SANTA ISABEL</span><h2>{copy.title}</h2><p>{copy.detail}</p><div className="adoption-hero-benefit"><i>✓</i><span><small>CAPACIDAD ACTIVA</small><strong>{copy.benefit}</strong></span></div></div>
      <div className="adoption-hero-progress"><div className="adoption-orbit"><strong>{copy.number}<small>/ 3</small></strong></div><span className={`adoption-edge-apply ${dashboard.edgeApplication?.applied ? "applied" : "pending"}`}><i />{dashboard.edgeApplication?.applied ? "Aplicado en el edge" : online ? "Esperando confirmación del edge" : "Edge sin reporte reciente"}</span></div>
    </section>

    <section className="panel adoption-path" aria-label="Etapas de adopción tecnológica"><div className="adoption-section-heading"><div><span className="eyebrow">Ruta de madurez</span><h2>El mínimo exigido crece; la mejor evidencia siempre cuenta</h2></div>{canManageStage && <button className="secondary-button compact" type="button" onClick={() => { setError(""); if (!editing) { setStage(current); setReviewAt(dashboard.settings.reviewAt ? dateTimeLocalValue(new Date(dashboard.settings.reviewAt)) : ""); } setEditing(!editing); }}>{editing ? "Cerrar decisión" : "Revisar etapa"}</button>}</div><ol>{adoptionStages.map((item, index) => { const itemCopy = adoptionStageCopy[item]; const active = item === current; const completed = index < currentIndex; return <li className={`${active ? "active" : ""} ${completed ? "completed" : ""}`} key={item}><span>{completed ? "✓" : itemCopy.number}</span><div><small>ETAPA {itemCopy.number}</small><strong>{itemCopy.title}</strong><p>{itemCopy.benefit}</p></div>{active && <b>ACTUAL</b>}</li>; })}</ol>
      {editing && <form className="adoption-decision-form" onSubmit={save}><div className="form-grid"><label>Nueva etapa<select value={stage} onChange={(event) => setStage(event.target.value as TechnologyAdoptionStage)}>{allowedStages.map((item) => <option value={item} key={item}>Etapa {adoptionStageCopy[item].number} · {adoptionStageCopy[item].title}</option>)}</select></label><label>Próxima revisión<input type="datetime-local" value={reviewAt} onChange={(event) => setReviewAt(event.target.value)} min={localDateTimeFromNow(1)} /></label><label className="full">Fundamento de la decisión<textarea value={note} onChange={(event) => setNote(event.target.value)} minLength={8} maxLength={500} required placeholder="Ej. El equipo supera 90 % de cargas identificadas durante el último mes." /></label></div><div className="form-note warning"><span>!</span>El cambio afectará sólo nuevas autorizaciones. Una carga ya iniciada conserva la política con que fue aprobada.</div>{error && <div className="auth-error" role="alert"><span>!</span>{error}</div>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setEditing(false)}>Cancelar</button><button className="primary-button" disabled={saving || note.trim().length < 8}>{saving ? "Guardando…" : "Registrar decisión"}</button></div></form>}
    </section>

    <section className="adoption-audiences">
      <article className="panel adoption-operator-card"><div><span className="eyebrow">Guía en terreno</span><h2>Una secuencia clara en el surtidor</h2><p>{current === "assisted" ? "Practica el flujo completo sin convertir el aprendizaje en una barrera para la faena." : current === "rfid_only" ? "Tu tag identifica la carga; cada uso del MIM agrega el equipo a la trazabilidad." : "La confirmación asegura que operador y máquina están autorizados antes de abastecer."}</p></div><ol>{operatorSteps.map((step, index) => <li key={step}><span>{index + 1}</span><p>{step}</p></li>)}</ol></article>
      <article className="panel adoption-manager-card"><div><span className="eyebrow">Progreso de la etapa</span><h2>{dashboard.recommendation.title}</h2><p>{dashboard.recommendation.detail}</p></div><div className={`adoption-readiness ${dashboard.recommendation.ready ? "ready" : "learning"}`}><span>{dashboard.recommendation.ready ? "✓" : "↗"}</span><strong>{dashboard.recommendation.ready ? "Preparado para revisión" : "Hábito en formación"}</strong></div><dl><div><dt>Revisión acordada</dt><dd>{dashboard.settings.reviewAt ? formatAlertDate(dashboard.settings.reviewAt) : "Por definir"}</dd></div><div><dt>Última decisión</dt><dd>{dashboard.settings.updatedByName ?? "Inicio del programa"}</dd></div></dl></article>
    </section>

    {current === "assisted" && canSchedule && <ManualModePanel edge={edge} online={online} onRefresh={onRefresh} variant="adoption" />}

    <section className="panel adoption-management"><div className="adoption-section-heading"><div><span className="eyebrow">Indicadores desde el inicio</span><h2>Valor capturado por la nueva forma de trabajar</h2><p>Los porcentajes usan litros efectivamente despachados, no clics ni aperturas de pantalla.</p></div><strong>{formatCompactLiters(dashboard.metrics.totalLiters)}<small>base observada</small></strong></div><div className="adoption-metrics"><AdoptionMetric label="Identidad RFID" value={dashboard.metrics.rfidCoverage} detail={`${dashboard.metrics.identifiedLoads} cargas · ${formatCompactLiters(dashboard.metrics.identifiedLiters)}`} tone="rfid" /><AdoptionMetric label="Trazabilidad completa" value={dashboard.metrics.fullCoverage} detail={`${dashboard.metrics.fullLoads} cargas · ${formatCompactLiters(dashboard.metrics.fullLiters)}`} tone="full" /><div className="adoption-assisted-metric"><span>SESIONES ASISTIDAS</span><strong>{dashboard.metrics.assistedLoads}</strong><p>{formatCompactLiters(dashboard.metrics.assistedLiters)} acompañados sin detener la operación</p></div></div>{dashboard.metrics.totalLoads === 0 && <div className="adoption-empty-data">Las próximas cargas comenzarán a construir la línea base de adopción del fundo.</div>}</section>

    <section className="adoption-bottom-grid"><article className="panel adoption-capabilities"><span className="eyebrow">Potencial tecnológico</span><h2>Lo que cada etapa incorpora</h2><ul><li className={currentIndex >= 0 ? "active" : ""}><i>✓</i><span><strong>Continuidad operacional</strong><small>Aprendizaje acompañado y auditable.</small></span></li><li className={currentIndex >= 1 ? "active" : ""}><i>{currentIndex >= 1 ? "✓" : "2"}</i><span><strong>Identidad del operador</strong><small>Responsabilidad RFID en cada carga.</small></span></li><li className={currentIndex >= 2 ? "active" : ""}><i>{currentIndex >= 2 ? "✓" : "3"}</i><span><strong>Identidad de la máquina</strong><small>MIM, asociación y fundo verificados.</small></span></li></ul></article></section>
  </div>;
}

function AdoptionMetric({ label, value, detail, tone }: { label: string; value: number; detail: string; tone: "rfid" | "full" }) {
  const bounded = Math.max(0, Math.min(100, value));
  return <div className={`adoption-metric ${tone}`}><div className="adoption-progress-ring" style={{ "--adoption-progress": `${bounded * 3.6}deg` } as CSSProperties}><strong>{bounded.toLocaleString("es-CL", { maximumFractionDigits: 1 })}<small>%</small></strong></div><span><small>{label}</small><strong>{detail}</strong></span></div>;
}

function Sidebar({ view, open, edgeOnline, validatorConnected, alertCount, permissions, roleCode, adoptionActive, onNavigate, onClose }: { view: View; open: boolean; edgeOnline: boolean; validatorConnected: boolean; alertCount: number; permissions: Permission[]; roleCode: string; adoptionActive: boolean; onNavigate: (view: View) => void; onClose: () => void }) {
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
              {navItems.filter((item) => item.group === group.id && (item.id !== "adoption" || adoptionActive) && canOpenView(item.id, permissions, roleCode)).map((item) => {
                const active = view === item.id
                  || (view === "machineMap" && item.id === "equipment")
                  || (view === "mimEnrollment" && item.id === "equipment")
                  || (view === "rfidCredentials" && item.id === "operators");
                return <button key={item.id} type="button" className={active ? "active" : ""} onClick={() => onNavigate(item.id)} aria-current={active ? "page" : undefined}>
                  <span className="nav-mark">{item.short}</span><span>{item.label}</span>
                  {item.id === "alerts" && alertCount > 0 && <b>{formatAlertBadge(alertCount)}</b>}
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

function canOpenView(view: View, permissions: Permission[], roleCode = "") {
  if (view === "overview" || view === "adoption") return permissions.includes("view_dashboard");
  if (view === "transactions" || view === "fuelHistory") return permissions.includes("view_transactions");
  if (view === "operators" || view === "rfidCredentials") return permissions.includes("manage_operators");
  if (view === "equipment" || view === "machineMap" || view === "mimEnrollment") return permissions.includes("manage_equipment");
  if (view === "associations") return permissions.includes("manage_associations");
  if (view === "access") return permissions.includes("manage_users");
  if (view === "data") return true;
  if (view === "system") {
    return permissions.includes("manage_system")
      || ["master", "administrator", "supervisor"].includes(roleCode);
  }
  return true;
}

function RefreshArrow({ spinning = false }: { spinning?: boolean }) {
  return <svg className={`refresh-arrow ${spinning ? "spinning" : ""}`} viewBox="0 0 20 20" focusable="false" aria-hidden="true"><path d="M15.7 6.6A6.2 6.2 0 1 0 16.1 12" /><path d="M15.8 3.8v3.4h-3.4" /></svg>;
}

function StatusMark({ confirmed = true }: { confirmed?: boolean }) {
  return <svg className="status-mark" viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">{confirmed
    ? <path d="M5.5 10 8.5 13 14.5 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    : <circle cx="10" cy="10" r="1.7" fill="currentColor" />}</svg>;
}

function ViewActions({ view, permissions, isProviderAdmin, onNavigate, onModal, onExport, exportDisabled }: { view: View; permissions: Permission[]; isProviderAdmin: boolean; onNavigate: (view: View) => void; onModal: (modal: Modal) => void; onExport: () => void; exportDisabled: boolean }) {
  if (view === "operators" && permissions.includes("manage_operators")) return <div className="page-actions"><button className="secondary-button" type="button" onClick={() => onNavigate("rfidCredentials")}>⌁ Credenciales RFID</button><button className="primary-button" type="button" onClick={() => onModal({ type: "operator" })}>＋ Nuevo operador</button></div>;
  if (view === "rfidCredentials" && permissions.includes("manage_operators")) return <div className="page-actions"><button className="secondary-button" type="button" onClick={() => onNavigate("operators")}>← Operadores</button>{isProviderAdmin && <button className="primary-button" type="button" onClick={() => onModal({ type: "createCredential" })}>＋ Enrolar RFID</button>}</div>;
  if (view === "equipment" && permissions.includes("manage_equipment")) return <div className="page-actions"><button className="secondary-button" type="button" onClick={() => onNavigate("machineMap")}>◎ Mapa de máquinas</button><button className="primary-button" type="button" onClick={() => onNavigate("mimEnrollment")}>＋ Enlazar nuevo MIM</button></div>;
  if (view === "mimEnrollment" && permissions.includes("manage_equipment")) return <button className="secondary-button" type="button" onClick={() => onNavigate("equipment")}>← Volver a equipos</button>;
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

function Overview({ alerts, transactions, sensor, edge, edgeOnline, equipment, adoption, nowMs, canScanNetwork, canViewFuelHistory, networkScanState, onNetworkScan, onNavigate, onTransaction }: { alerts: AlertItem[]; transactions: Transaction[]; sensor: FuelHistoryResponse["sensor"] | null; edge: FuelHistoryResponse["edge"]; edgeOnline: boolean; equipment: Equipment[]; adoption: TechnologyAdoptionDashboard | null; nowMs: number; canScanNetwork: boolean; canViewFuelHistory: boolean; networkScanState: NetworkScanState; onNetworkScan: () => void; onNavigate: (view: View) => void; onTransaction: (id: string) => void }) {
  const todayKey = siteDateKey(nowMs);
  const today = transactions.filter((item) => siteDateKey(item.occurredAt) === todayKey);
  const todayDispatches = today.filter((item) => item.status !== "Habilitación de bomba");
  const todayEnablements = today.filter((item) => item.status === "Habilitación de bomba");
  const todayLiters = todayDispatches.reduce((total, item) => total + item.liters, 0);
  const todayEnablementLiters = todayEnablements.reduce((total, item) => total + item.liters, 0);
  const weeklyDays = Array.from({ length: 7 }, (_, offset) => {
    const day = new Date(`${todayKey}T12:00:00Z`);
    day.setUTCDate(day.getUTCDate() - (6 - offset));
    return day;
  });
  const weeklyValues = weeklyDays.map((day) => transactions.filter((item) =>
    item.status !== "Habilitación de bomba" && siteDateKey(item.occurredAt) === siteDateKey(day)
  ).reduce((total, item) => total + item.liters, 0));
  const weeklyTotal = weeklyValues.reduce((total, value) => total + value, 0);
  const weeklyMax = Math.max(1, ...weeklyValues);
  const weeklyAxisMaximum = niceFuelAxisMaximum(weeklyMax);
  const weeklyAxisTicks = fuelAxisTicks(weeklyAxisMaximum);
  const levelDisplay = fuelLevelDisplay(sensor, edge, nowMs);
  const controlHealthy = Boolean(edgeOnline && edge?.validatorOnline && edge.nfcReady && edge.k24Enabled && edge.k24Healthy);
  const automaticReady = Boolean(controlHealthy && edge?.state === "locked");
  const manualModeActive = Boolean(controlHealthy && edge?.state === "manual_mode" && edge.relayEnergized);
  const dispatchInProgress = Boolean(controlHealthy && edge?.state === "dispensing");
  const dispatchAuthorized = Boolean(controlHealthy && edge?.state === "authorized");
  const receiptInProgress = levelDisplay.fresh && (sensor?.detectionStatus === "rising" || sensor?.detectionStatus === "detecting");
  const operational = automaticReady || manualModeActive || dispatchInProgress || dispatchAuthorized || receiptInProgress;
  const operationalTitle = dispatchInProgress
    ? "Carga en curso · flujo K24 detectado"
    : dispatchAuthorized
      ? "Carga autorizada · esperando flujo"
      : receiptInProgress
        ? "Recepción al estanque en curso"
        : manualModeActive
    ? "Modo manual activo"
    : automaticReady ? "Disponible para una nueva carga" : "Estado operacional sin confirmar";
  const operationalDetail = dispatchInProgress
    ? "El PLC está contabilizando pulsos. La carga aparecerá en el historial cuando termine el flujo."
    : dispatchAuthorized
      ? "La bomba está habilitada y el sistema espera el primer pulso del medidor."
      : receiptInProgress
        ? `El OCIO observa un aumento de ${formatLiters(sensor?.observedRiseLiters)}. ${sensor?.detectionStatus === "detecting" ? "La detección se confirmará al estabilizarse el nivel." : `El umbral de recepción es ${formatLiters(sensor?.receiptThresholdLiters)}.`}`
        : manualModeActive
    ? "R0.1 permanece habilitado durante la ventana manual. Los tags permiten imputar cada consumo sin interrumpir la bomba."
    : automaticReady
      ? null
      : "La aplicación espera un reporte reciente y saludable del controlador antes de mostrar disponibilidad.";
  const componentHealth = [
    ["PLC", edgeOnline], ["Validador", Boolean(edgeOnline && edge?.validatorOnline)],
    ["RFID", Boolean(edgeOnline && edge?.nfcReady)], ["K24", Boolean(edgeOnline && edge?.k24Enabled && edge?.k24Healthy)],
    ["OCIO", levelDisplay.fresh],
  ] as const;
  return (
    <div className="overview-grid">
      <section className="hero-status panel">
        <div className="hero-copy">
          <details className="overview-info">
            <summary aria-label="Ver notas de control"><span aria-hidden="true">i</span></summary>
            <div className="overview-info-popover" aria-label="Notas de control">
              <article>
                <span aria-hidden="true">i</span>
                <p><strong>Control local en espera</strong>El operador puede presentar su credencial en el validador.</p>
              </article>
              <article>
                <span aria-hidden="true">i</span>
                <p><strong>Control local en el borde</strong>El dashboard observa la operación. La habilitación física pertenece exclusivamente al PLC.</p>
              </article>
            </div>
          </details>
          <div className="status-label"><span className={`ready-ring ${operational ? "" : "offline"}`}><i><StatusMark confirmed={operational} /></i></span><div><small>ESTADO DEL PUNTO</small><strong>{operationalTitle}</strong></div></div>
          {operationalDetail && <p>{operationalDetail}</p>}
          <div className="readiness-row">
            {componentHealth.map(([item, healthy]) => <span key={item} aria-label={`${item}: ${healthy ? "Disponible" : "Sin confirmar"}`}><i><StatusMark confirmed={healthy} /></i>{item}</span>)}
          </div>
          {canScanNetwork && <button className={`overview-scan-button ${networkScanState}`} type="button" onClick={onNetworkScan} disabled={networkScanState === "scanning"} aria-busy={networkScanState === "scanning"}><span className="scan-refresh-icon">{networkScanState === "updated" ? "✓" : networkScanState === "failed" ? "!" : <RefreshArrow spinning={networkScanState === "scanning"} />}</span><span aria-live="polite"><strong>{networkScanState === "scanning" ? "Escaneando red…" : networkScanState === "updated" ? "Red actualizada" : networkScanState === "failed" ? "No fue posible actualizar la red" : "Buscar equipos en la red"}</strong>{networkScanState === "scanning" && <small>Búsqueda de 10 segundos</small>}</span></button>}
        </div>
        <div className="tank-card">
          <div className="tank-gauge" role="img" aria-label={`${levelDisplay.label}: ${levelDisplay.volumeLabel}. ${levelDisplay.variationLabel ?? ""}`}>
            <FuelTankGauge percent={levelDisplay.percent} minPercent={levelDisplay.isRange ? levelDisplay.minPercent : null} maxPercent={levelDisplay.isRange ? levelDisplay.maxPercent : null} />
          </div>
          <div className="tank-meta">
            <span>{levelDisplay.label}</span>
            <strong>{levelDisplay.percentLabel}</strong>
            <div className="tank-volume"><b>{levelDisplay.volumeLabel}</b><em>{sensor ? `de ${formatCompactLiters(sensor.capacityLiters)}` : "OCIO pendiente"}</em></div>
            <small>{levelDisplay.statusLabel}</small>
            {levelDisplay.variationLabel && <small>{levelDisplay.variationLabel}</small>}
            <small>{sensor?.latestReadingAt && !sensor.latestReadingAt.startsWith("1970") ? `OCIO · ${formatHistoryDate(sensor.latestReadingAt)}` : "Esperando primera lectura OCIO"}</small>
          </div>
        </div>
      </section>

      <section className="metrics-grid" aria-label="Indicadores del día">
        <Metric label="Litros despachados hoy" value={formatLiters(todayLiters)} tone="blue" />
        <Metric label="Cargas completadas" value={String(today.filter((item) => item.status === "Completada").length)} tone="violet" />
        <Metric label="Habilitaciones de bomba" value={String(todayEnablements.length)} delta={todayEnablementLiters > 0 ? `${formatLiters(todayEnablementLiters)} sin suministro posterior` : undefined} tone="sky" />
        <Metric label="Equipos habilitados" value={`${equipment.filter((item) => !item.archivedAt && item.active).length} / ${equipment.filter((item) => !item.archivedAt).length}`} tone="ink" />
      </section>

      {adoption && <section className={`panel adoption-overview-card stage-${adoption.settings.stage}`}>
        <div className="adoption-overview-stage"><span>{adoptionStageCopy[adoption.settings.stage].number}</span><div><small>ADOPCIÓN TECNOLÓGICA · ETAPA ACTUAL</small><strong>{adoptionStageCopy[adoption.settings.stage].title}</strong></div></div>
        <p>{adoption.settings.stage === "assisted" ? "El equipo está practicando RFID y MIM con acompañamiento, sin detener la faena." : adoption.settings.stage === "rfid_only" ? "Cada carga exige identidad RFID; el MIM suma trazabilidad completa cuando está disponible." : "El fundo ya opera con RFID, MIM y asociación como evidencia mínima."}</p>
        <div className="adoption-overview-evidence"><span><small>RFID</small><strong>{adoption.metrics.rfidCoverage.toLocaleString("es-CL", { maximumFractionDigits: 1 })}%</strong></span><span><small>TRAZABILIDAD COMPLETA</small><strong>{adoption.metrics.fullCoverage.toLocaleString("es-CL", { maximumFractionDigits: 1 })}%</strong></span></div>
        <button className="secondary-button compact" type="button" onClick={() => onNavigate("adoption")}>Ver ruta y próximos pasos →</button>
      </section>}

      <section className="panel volume-panel">
        <div className="panel-heading weekly-heading"><div><span className="eyebrow">Últimos 7 días</span><h2>Volumen despachado</h2></div><div className="weekly-heading-actions"><strong>{formatCompactLiters(weeklyTotal)}<small>total semanal</small></strong>{canViewFuelHistory && <button className="secondary-button" type="button" onClick={() => onNavigate("fuelHistory")}>Ver histórico <span aria-hidden="true">→</span></button>}</div></div>
        <div className="overview-chart" aria-label="Gráfico de volumen semanal con escala en litros">
          <div className="overview-chart-guides" aria-hidden="true">{weeklyAxisTicks.map((tick, index) => <span key={`${tick}-${index}`} style={{ top: `${index / (weeklyAxisTicks.length - 1) * 100}%` }} />)}</div>
          <div className="overview-chart-axis" aria-label="Escala vertical de volumen despachado">{weeklyAxisTicks.map((tick, index) => <span key={`${tick}-${index}`} style={{ top: `${index / (weeklyAxisTicks.length - 1) * 100}%` }}>{formatLiters(tick)}</span>)}</div>
          <div className="bar-chart">
            {weeklyValues.map((value, index) => {
              const dayLabel = formatSiteDate(weeklyDays[index], { weekday: "short" }).replace(".", "");
              return <div className="bar-column" key={index}><div className="bar-track"><button type="button" className={`weekly-bar chart-tooltip-target ${value === 0 ? "zero" : ""}`} data-tooltip={`${formatLiters(value)} despachados`} aria-label={`${dayLabel}: ${formatLiters(value)} despachados`} style={{ height: `${value ? Math.max(3, value / weeklyAxisMaximum * 100) : 0}%` }} /></div><small>{dayLabel}</small></div>;
            })}
          </div>
        </div>
      </section>

      <section className="panel alerts-panel">
        <div className="panel-heading"><div><span className="eyebrow">Atención</span><h2>Alertas recientes</h2></div><button className="text-button" onClick={() => onNavigate("alerts")}>Ver todas →</button></div>
        <div className="compact-alerts">
          {alerts.slice(0, 3).map((alert) => <div key={alert.id} className={`compact-alert ${alert.severity}`}><span className="alert-symbol">{alert.severity === "warning" ? "!" : "i"}</span><div><strong>{alert.title}</strong><small>{alert.detail}</small></div><time dateTime={alert.time} title="Hora de Chile · America/Santiago">{formatAlertDate(alert.time)}</time></div>)}
        </div>
      </section>

      <section className="panel recent-panel">
        <div className="panel-heading"><div><span className="eyebrow">Trazabilidad</span><h2>Movimientos recientes</h2></div><button className="text-button" onClick={() => onNavigate("transactions")}>Ver historial →</button></div>
        <TransactionTable items={transactions.slice(0, 4)} onOpen={onTransaction} compact />
      </section>
    </div>
  );
}

function Metric({ label, value, delta, tone }: { label: string; value: string; delta?: string; tone: string }) {
  return <article className={`metric-card ${tone}`}><span className="metric-accent" /><p>{label}</p><strong>{value}</strong>{delta && <small>{delta}</small>}</article>;
}

function SearchBar({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return <label className="search-bar"><span>⌕</span><input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} /></label>;
}

function Transactions({ search, status, items, allItems, edge, edgeOnline, onSearch, onStatus, onExport, onOpen }: { search: string; status: TransactionStatusFilter; items: Transaction[]; allItems: Transaction[]; edge: FuelHistoryResponse["edge"]; edgeOnline: boolean; onSearch: (value: string) => void; onStatus: (value: TransactionStatusFilter) => void; onExport: () => void; onOpen: (id: string) => void }) {
  const filters: { label: string; value: TransactionStatusFilter }[] = [
    { label: "Completadas", value: "Completada" },
    { label: "Todas", value: "Todas" },
    { label: "Habilitaciones", value: "Habilitación de bomba" },
    { label: "Excepcionales", value: "Excepcional" },
    { label: "Interrumpidas", value: "Interrumpida" },
  ];
  const liveState = edgeOnline && edge && ["validating", "authorized", "dispensing", "closing"].includes(edge.state)
    ? edge.state : null;
  const liveCopy = liveState === "dispensing"
    ? ["Carga en curso", "K24 está contabilizando flujo. El volumen definitivo aparecerá al cerrar la carga."]
    : liveState === "authorized"
      ? ["Carga autorizada", "La bomba está habilitada y espera el primer pulso K24."]
      : liveState === "validating"
        ? ["Validando carga", "El PLC está verificando la credencial y la evidencia disponible."]
        : liveState === "closing"
          ? ["Cerrando carga", "El PLC está consolidando volumen, identidad y motivo de cierre."]
          : null;
  return (
    <div className="stack">
      {liveCopy && <section className={`panel live-operation-banner ${liveState}`} role="status" aria-live="polite"><span className="live-operation-pulse" /><div><small>DETECCIÓN AUTOMÁTICA · EN VIVO</small><strong>{liveCopy[0]}</strong><p>{liveCopy[1]}</p></div></section>}
      <section className="filter-panel panel"><SearchBar value={search} onChange={onSearch} placeholder="Buscar por ID, operador o equipo" /><div className="filter-pills" aria-label="Filtrar cargas por estado">{filters.map((filter) => <button type="button" key={filter.value} className={status === filter.value ? "active" : ""} aria-pressed={status === filter.value} onClick={() => onStatus(filter.value)}>{filter.label}<span>{filter.value === "Todas" ? allItems.length : allItems.filter((item) => item.status === filter.value).length}</span></button>)}</div><button className="mobile-export secondary-button" onClick={onExport} disabled={items.length === 0}>↓ Exportar</button></section>
      <section className="panel table-panel"><div className="table-summary"><span><strong>{items.length}</strong> {items.length === 1 ? "movimiento encontrado" : "movimientos encontrados"}</span><small>Datos conservados localmente por 1 año</small></div><TransactionTable items={items} onOpen={onOpen} emptyDetail={search || status !== "Todas" ? "Ajusta la búsqueda o selecciona otro estado." : "Todavía no existen movimientos registrados."} /></section>
    </div>
  );
}

type HistoryScope = "week" | "month" | "year" | "custom";
type HistoryGranularity = "day" | "week" | "month" | "year";

function FuelHistoryView({ canManageReceipts, nowMs }: { canManageReceipts: boolean; nowMs: number }) {
  const [historyTab, setHistoryTab] = useState<"inventory" | "machines">("inventory");
  const initialRange = useMemo(() => historyRange("month"), []);
  const [scope, setScope] = useState<HistoryScope>("month");
  const [granularity, setGranularity] = useState<HistoryGranularity>("week");
  const [movementFilter, setMovementFilter] = useState<"all" | FuelMovement["type"] | "pump_enablement">("all");
  const [from, setFrom] = useState(initialRange.from);
  const [to, setTo] = useState(initialRange.to);
  const [data, setData] = useState<FuelHistoryResponse | null>(null);
  const levelDisplay = fuelLevelDisplay(data?.sensor, data?.edge, nowMs);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [receiptDialog, setReceiptDialog] = useState<{ type: "manual" } | { type: "review"; movement: FuelMovement } | null>(null);
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
  }, [from, to, refreshRevision]);

  const points = useMemo(() => aggregateFuelMovements(data?.movements ?? [], granularity), [data, granularity]);
  const shownMovements = useMemo(() => (data?.movements ?? []).filter((movement) => movementFilter === "all" || (movementFilter === "pump_enablement" ? movement.classification === "pump_enablement" : movement.type === movementFilter && movement.classification === "standard")), [data, movementFilter]);
  const maxFlow = Math.max(1, ...points.flatMap((point) => [point.received, point.dispatched]));
  const axisMaximum = niceFuelAxisMaximum(maxFlow);
  const axisTicks = fuelAxisTicks(axisMaximum);
  const tankCapacity = Math.max(1, data?.sensor.capacityLiters ?? Math.max(...points.map((point) => point.closingLevel), 1));
  const tankAxisTicks = fuelAxisTicks(tankCapacity);
  const levelLinePoints = points.map((point, index) => `${(index + .5) * 100},${100 - fuelLevelPercent(point.closingLevel, tankCapacity)}`).join(" ");
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
    const header = "Fecha,Tipo,Litros conciliados,Litros detectados,Nivel inicial,Nivel final,Origen,Referencia interna,Referencia documental,Detección,Conciliación,Revisado por,Motivo";
    const rows = data.movements.map((item) => [
      item.occurredAt, item.classification === "pump_enablement" ? "Habilitación de bomba" : item.type === "receipt" ? "Recepción" : "Despacho", formatVolumeCsv(item.liters),
      formatVolumeCsv(item.originalLiters), formatVolumeCsv(item.openingLevel), formatVolumeCsv(item.closingLevel), item.source, item.reference,
      item.documentReference ?? "", item.detectedAutomatically ? "Automática" : "Manual / trazable",
      receiptReviewCopy(item.reviewStatus), item.reviewedByName ?? "", item.reviewNote ?? "",
    ].map(csvCell).join(","));
    const url = URL.createObjectURL(new Blob([`\uFEFF${[header, ...rows].join("\n")}`], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `historico-combustible-${from}-${to}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };
  const receivedCount = data?.movements.filter((item) => item.type === "receipt" && isReconciledReceipt(item)).length ?? 0;
  const receiptMovementCount = data?.movements.filter((item) => item.type === "receipt").length ?? 0;
  const dispatchedCount = data?.movements.filter((item) => item.type === "dispatch").length ?? 0;
  const pumpEnablementCount = data?.movements.filter((item) => item.classification === "pump_enablement").length ?? 0;
  const classicDispatchCount = dispatchedCount - pumpEnablementCount;
  const openLedger = (type: FuelMovement["type"]) => {
    setMovementFilter(type);
    window.requestAnimationFrame(() => ledgerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };
  const refreshAfterReceiptChange = (message: string) => {
    setNotice(message);
    setReceiptDialog(null);
    setRefreshRevision((value) => value + 1);
  };

  return <div className="fuel-history-stack">
    <div className="fuel-history-tabs" role="tablist" aria-label="Vistas del histórico de combustible">
      {([['inventory', 'Inventario y movimientos'], ['machines', 'Por máquina']] as const).map(([value, label], index) => <button type="button" key={value} role="tab" id={`history-tab-${value}`} aria-controls={`history-panel-${value}`} aria-selected={historyTab === value} tabIndex={historyTab === value ? 0 : -1} onClick={() => setHistoryTab(value)} onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === "Home" ? "inventory" : event.key === "End" ? "machines" : index === 0 ? "machines" : "inventory";
        setHistoryTab(next); document.getElementById(`history-tab-${next}`)?.focus();
      }}><span aria-hidden="true" className={value === "machines" ? "history-machine-icon" : "history-movements-icon"}>{value === "inventory" ? "↕" : null}</span>{label}</button>)}
    </div>
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
      {historyTab === "inventory" && <button className="secondary-button history-export" type="button" onClick={exportHistory} disabled={!data || data.movements.length === 0}>↓ Exportar CSV</button>}
      {historyTab === "inventory" && canManageReceipts && <button className="primary-button history-manual-receipt" type="button" onClick={() => { setNotice(""); setReceiptDialog({ type: "manual" }); }}>＋ Registrar recepción</button>}
    </section>

    <div className="fuel-history-tab-panel" id="history-panel-machines" role="tabpanel" aria-labelledby="history-tab-machines" hidden={historyTab !== "machines"}>
      <MachineFuelPanel from={from} to={to} active={historyTab === "machines"} />
    </div>
    <div className="fuel-history-tab-panel" id="history-panel-inventory" role="tabpanel" aria-labelledby="history-tab-inventory" hidden={historyTab !== "inventory"}>
    {error && <div className="auth-error" role="alert"><span>!</span>{error}</div>}
    {notice && <div className="access-notice" role="status"><span>✓</span>{notice}</div>}
    {levelDisplay.fresh && data?.sensor.detectionStatus && data.sensor.detectionStatus !== "monitoring" && <section className={`panel live-operation-banner receipt-${data.sensor.detectionStatus}`} role="status" aria-live="polite"><span className="live-operation-pulse" /><div><small>OCIO · DETECCIÓN AUTOMÁTICA</small><strong>{data.sensor.detectionStatus === "warming_up" ? "Estabilizando la referencia de nivel" : data.sensor.detectionStatus === "detecting" ? "Recepción candidata en curso" : "Aumento de nivel observado"}</strong><p>{data.sensor.detectionStatus === "warming_up" ? "El detector conserva la referencia anterior mientras valida las primeras muestras de la sesión." : `${formatLiters(data.sensor.observedRiseLiters)} observados desde la referencia. ${data.sensor.detectionStatus === "detecting" ? "Se confirmará como una sola recepción cuando el nivel se estabilice." : `El registro automático comienza desde ${formatLiters(data.sensor.receiptThresholdLiters)}.`}`}</p></div></section>}
    {(data?.pendingReceipts.length ?? 0) > 0 && <section className="panel receipt-review-queue" aria-label="Recepciones pendientes de revisión">
      <div className="receipt-review-head"><div><span className="eyebrow">CONCILIACIÓN PENDIENTE</span><h2>{data!.pendingReceipts.length} {data!.pendingReceipts.length === 1 ? "detección requiere" : "detecciones requieren"} revisión</h2><p>El sensor confirmó una subida sostenida. Estos volúmenes no se suman al inventario conciliado hasta que una persona los apruebe.</p></div><span className="receipt-review-counter">{data!.pendingReceipts.length}</span></div>
      <div className="receipt-review-grid">{data!.pendingReceipts.map((item) => <article className="receipt-review-card" key={item.id}>
        <div className="receipt-review-card-head"><span className="movement-icon">↙</span><div><strong>{formatLiters(item.originalLiters ?? item.liters)} detectados</strong><time>{formatHistoryDate(item.occurredAt)}</time></div><span className="automatic-tag">{Math.round(item.confidence * 100)}% confianza</span></div>
        <div className="receipt-evidence"><span><small>Nivel OCIO</small><strong>{formatCompactLiters(item.openingLevel)} → {formatCompactLiters(item.closingLevel)}</strong></span><span><small>Referencia</small><strong>{item.reference}</strong></span></div>
        {canManageReceipts ? <button className="primary-button" type="button" onClick={() => { setNotice(""); setReceiptDialog({ type: "review", movement: item }); }}>Revisar recepción</button> : <p className="receipt-review-readonly">Un supervisor o administrador debe revisar esta detección.</p>}
      </article>)}</div>
    </section>}
    <section className="history-kpis" aria-label="Resumen del período">
      <article className="history-kpi received"><span className="history-kpi-icon">↙</span><div><small>Combustible recibido</small><strong>{formatLiters(data?.summary.receivedLiters)}</strong><span>{receivedCount} {receivedCount === 1 ? "recepción" : "recepciones"}</span></div></article>
      <article className="history-kpi dispatched"><span className="history-kpi-icon">↗</span><div><small>Total despachado</small><strong>{formatLiters(data?.summary.dispatchedLiters)}</strong><span>{classicDispatchCount} despachos · {pumpEnablementCount} habilitaciones ({formatLiters(data?.summary.pumpEnablementLiters)})</span></div></article>
      <article className="history-kpi balance"><span className="history-kpi-icon">±</span><div><small>Balance del período</small><strong>{data ? `${data.summary.netLiters >= 0 ? "+" : ""}${formatLiters(data.summary.netLiters)}` : "—"}</strong></div></article>
      <article className="history-kpi level"><FuelTankGauge compact percent={levelDisplay.percent} minPercent={levelDisplay.isRange ? levelDisplay.minPercent : null} maxPercent={levelDisplay.isRange ? levelDisplay.maxPercent : null} /><div><small>{levelDisplay.label}</small><strong>{levelDisplay.volumeLabel}</strong><small>{levelDisplay.statusLabel}</small>{levelDisplay.variationLabel && <small>{levelDisplay.variationLabel}</small>}<span>{levelDisplay.hasReading ? `${levelDisplay.percentLabel} de ${formatCompactLiters(data!.sensor.capacityLiters)}` : "Esperando primera lectura OCIO"}</span></div></article>
    </section>

    <section className="panel fuel-history-chart-panel">
      <div className="history-panel-head">
        <div><span className="eyebrow">Comportamiento del inventario</span><h2>Entradas y salidas</h2></div>
        <div className="chart-controls"><span>Agrupar por</span><div className="segmented-control compact">{([['day', 'Día'], ['week', 'Semana'], ['month', 'Mes'], ['year', 'Año']] as const).map(([value, label]) => <button type="button" key={value} className={granularity === value ? "active" : ""} aria-pressed={granularity === value} onClick={() => setGranularity(value)}>{label}</button>)}</div></div>
      </div>
      <div className="history-chart-legend"><span><i className="receipt" />Recepciones</span><span><i className="dispatch" />Despachos</span><span><i className="level" />Nivel del estanque</span></div>
      {loading ? <div className="history-loading" role="status">Reconstruyendo el histórico local…</div> : points.length === 0 ? <EmptyState title="Sin movimientos en este período" detail="Amplía el rango de fechas para revisar actividad anterior." /> : <div className="history-chart-scroll"><div className="fuel-history-chart" style={{ minWidth: `${Math.max(720, points.length * 82 + 140)}px` }}>
        <div className="chart-guides">{axisTicks.map((tick, index) => <span key={`${tick}-${index}`} />)}</div>
        <div className="fuel-chart-axis fuel-chart-axis-left" data-axis-label="MOVIMIENTOS" aria-label="Escala vertical en litros para recepciones y despachos">{axisTicks.map((tick, index) => <span key={`${tick}-${index}`}>{formatLiters(tick)}</span>)}</div>
        <div className="fuel-chart-axis fuel-chart-axis-right" data-axis-label="NIVEL" aria-label="Escala derecha del nivel del estanque en litros">{tankAxisTicks.map((tick, index) => <span key={`${tick}-${index}`}>{formatLiters(tick)}</span>)}</div>
        <div className="fuel-chart-plot" style={{ gridTemplateColumns: `repeat(${points.length}, minmax(62px, 1fr))` }}>
          {points.length > 1 && <svg className="inventory-level-line" viewBox={`0 0 ${points.length * 100} 100`} preserveAspectRatio="none" aria-hidden="true"><polyline points={levelLinePoints} vectorEffect="non-scaling-stroke" /></svg>}
          {points.map((point) => <div className="fuel-chart-column" key={point.key}>
            <div className="fuel-bars">
              <button type="button" className="received-bar chart-tooltip-target" disabled={!point.received} data-tooltip={`${formatLiters(point.received)} recibidos`} aria-label={`Ver recepciones de ${point.label}: ${formatLiters(point.received)}`} onClick={() => openLedger("receipt")} style={{ height: `${point.received ? Math.max(3, point.received / axisMaximum * 100) : 0}%` }} />
              <button type="button" className="dispatched-bar chart-tooltip-target" disabled={!point.dispatched} data-tooltip={`${formatLiters(point.dispatched)} despachados`} aria-label={`Ver despachos de ${point.label}: ${formatLiters(point.dispatched)}`} onClick={() => openLedger("dispatch")} style={{ height: `${point.dispatched ? Math.max(3, point.dispatched / axisMaximum * 100) : 0}%` }} />
              <button type="button" className="inventory-level-dot chart-tooltip-target" data-tooltip={`Nivel: ${formatLiters(point.closingLevel)}`} aria-label={`${point.label}, nivel del estanque: ${formatLiters(point.closingLevel)}`} style={{ bottom: `${fuelLevelPercent(point.closingLevel, tankCapacity)}%` }} />
            </div>
            <strong>{point.label}</strong><small>{formatCompactLiters(point.received + point.dispatched)} mov.</small>
          </div>)}
        </div>
      </div></div>}
    </section>

    <section className="panel fuel-ledger" id="fuel-ledger" ref={ledgerRef}>
      <div className="history-panel-head ledger-head">
        <div><span className="eyebrow">Registro auditable</span><h2>Movimientos del período</h2></div>
        <div className="movement-filters" aria-label="Filtrar movimientos">
          <button className={movementFilter === "all" ? "active" : ""} aria-pressed={movementFilter === "all"} onClick={() => setMovementFilter("all")}>Todos <span>{data?.movements.length ?? 0}</span></button>
          <button className={movementFilter === "receipt" ? "active" : ""} aria-pressed={movementFilter === "receipt"} onClick={() => setMovementFilter("receipt")}>Recepciones <span>{receiptMovementCount}</span></button>
          <button className={movementFilter === "dispatch" ? "active" : ""} aria-pressed={movementFilter === "dispatch"} onClick={() => setMovementFilter("dispatch")}>Despachos <span>{classicDispatchCount}</span></button>
          <button className={movementFilter === "pump_enablement" ? "active" : ""} aria-pressed={movementFilter === "pump_enablement"} onClick={() => setMovementFilter("pump_enablement")}>Habilitaciones <span>{pumpEnablementCount}</span></button>
        </div>
      </div>
      <div className="fuel-ledger-columns" aria-hidden="true"><span>Movimiento</span><span>Volumen</span><span>Nivel del estanque</span><span>Origen y referencia</span></div>
      <div className="fuel-ledger-list">{shownMovements.map((item) => <article className={`fuel-ledger-row ${item.classification === "pump_enablement" ? "pump-enablement" : item.type} review-${item.reviewStatus}`} key={item.id}>
        <div className="movement-main"><span className="movement-icon">{item.classification === "pump_enablement" ? "◉" : item.type === "receipt" ? "↙" : "↗"}</span><div><strong>{item.classification === "pump_enablement" ? "Habilitación de bomba" : item.type === "receipt" ? "Recepción de combustible" : "Despacho de combustible"}</strong><time>{formatHistoryDate(item.occurredAt)}</time>{item.detectedAutomatically && <span className="automatic-tag">Detección automática · {Math.round(item.confidence * 100)}%</span>}{item.type === "receipt" && <span className={`receipt-review-badge ${item.reviewStatus}`}>{receiptReviewCopy(item.reviewStatus)}</span>}</div></div>
        <strong className="movement-liters">{item.type === "receipt" ? "+" : "−"}{formatLiters(item.liters)}</strong>
        <div className="level-transition"><span>{formatCompactLiters(item.openingLevel)}</span><i>→</i><strong>{formatCompactLiters(item.closingLevel)}</strong></div>
        <div className="movement-source"><strong>{item.source}</strong><span>{item.documentReference ?? item.reference}</span>{item.manualModeSessionId && <small>Sesión manual: {item.manualModeSessionId}</small>}<small>{item.reviewStatus === "corrected" && item.originalLiters != null ? `Sensor: ${formatLiters(item.originalLiters)} · ` : ""}{item.reviewNote ?? item.detail}</small>{item.reviewedByName && <small>Revisado por {item.reviewedByName}{item.reviewedAt ? ` · ${formatHistoryDate(item.reviewedAt)}` : ""}</small>}{canManageReceipts && item.type === "receipt" && item.reviewStatus !== "rejected" && <button className="text-button receipt-adjust-button" type="button" onClick={() => setReceiptDialog({ type: "review", movement: item })}>{item.reviewStatus === "pending" ? "Revisar" : "Ajustar conciliación"}</button>}</div>
      </article>)}</div>
      {!loading && shownMovements.length === 0 && <EmptyState title="No hay movimientos para este filtro" detail="Selecciona otro tipo de movimiento o amplía el período." />}
    </section>
    </div>
    {receiptDialog?.type === "review" && <ReceiptReviewDialog movement={receiptDialog.movement} onClose={() => setReceiptDialog(null)} onSaved={(message) => refreshAfterReceiptChange(message)} />}
    {receiptDialog?.type === "manual" && <ManualReceiptDialog onClose={() => setReceiptDialog(null)} onSaved={(message) => refreshAfterReceiptChange(message)} />}
  </div>;
}

function ReceiptReviewDialog({ movement, onClose, onSaved }: { movement: FuelMovement; onClose: () => void; onSaved: (message: string) => void }) {
  const [liters, setLiters] = useState(formatVolumeCsv(movement.liters));
  const [documentReference, setDocumentReference] = useState(movement.documentReference ?? "");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [requestId] = useState(clientRequestId);
  const correctedLiters = Number(liters.replace(",", "."));
  const isCorrection = Number.isFinite(correctedLiters) && correctedLiters !== Number(formatVolumeCsv(movement.liters));
  const documentChanged = documentReference.trim() !== (movement.documentReference ?? "");
  const alreadyReconciled = movement.reviewStatus === "approved" || movement.reviewStatus === "corrected";
  const isAdjustment = isCorrection || documentChanged;

  const save = async (action: "approve" | "correct" | "reject") => {
    setError("");
    if (action === "correct" && (!Number.isFinite(correctedLiters) || correctedLiters <= 0)) {
      setError("Ingresa un volumen corregido válido."); return;
    }
    if (action === "correct" && isCorrection && (correctedLiters > TANK_CAPACITY_LITERS || correctedLiters !== Number(formatVolumeCsv(correctedLiters)))) {
      setError(`Ingresa un volumen de hasta ${formatVolume(TANK_CAPACITY_LITERS)} L con un solo decimal.`); return;
    }
    if ((action === "correct" || action === "reject") && note.trim().length < 10) {
      setError("La corrección o rechazo requiere un motivo de al menos 10 caracteres."); return;
    }
    if (action === "correct" && documentReference.trim().length < 2) {
      setError("Agrega la guía, factura u otra referencia que respalda la corrección."); return;
    }
    setSubmitting(true);
    try {
      const response = await fetch(`/api/fuel-history/receipts/${encodeURIComponent(movement.id)}/review`, {
        method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId,
          action,
          liters: action === "correct" ? receiptVolumeToSave(correctedLiters, movement.liters) : undefined,
          documentReference: documentReference.trim() || undefined,
          note: note.trim() || undefined,
        }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "No fue posible revisar la recepción.");
      onSaved(action === "reject" ? "Detección rechazada y conservada para auditoría."
        : action === "correct" ? `Recepción corregida y conciliada en ${formatLiters(correctedLiters)}.`
        : "Recepción confirmada e incorporada al inventario conciliado.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No fue posible revisar la recepción.");
      setSubmitting(false);
    }
  };

  return <div className="modal-backdrop" role="presentation"><section className="modal receipt-review-modal" role="dialog" aria-modal="true" aria-label="Revisar recepción automática">
    <button className="modal-close" type="button" onClick={onClose} aria-label="Cerrar">×</button>
    <ModalIntro eyebrow="CONCILIACIÓN DE INVENTARIO" title={alreadyReconciled ? "Ajustar recepción conciliada" : "Revisar recepción automática"} detail={alreadyReconciled ? "Corrige el volumen o respaldo sin sobrescribir la evidencia ni las revisiones anteriores." : "Confirma la detección del OCIO o reemplaza el volumen por el documento del proveedor. La evidencia original no se modifica."} />
    <div className="receipt-detection-summary"><span><small>Detectado por el sensor</small><strong>{formatLiters(movement.originalLiters ?? movement.liters)}</strong></span><span><small>Nivel observado</small><strong>{formatCompactLiters(movement.openingLevel)} → {formatCompactLiters(movement.closingLevel)}</strong></span><span><small>Fecha</small><strong>{formatHistoryDate(movement.occurredAt)}</strong></span></div>
    <div className="form-grid receipt-review-form">
      <label>Volumen a conciliar (L)<input type="number" min="0.1" max={TANK_CAPACITY_LITERS} step="0.1" inputMode="decimal" value={liters} onChange={(event) => setLiters(event.target.value)} /></label>
      <label>Guía, factura o referencia<input maxLength={120} value={documentReference} onChange={(event) => setDocumentReference(event.target.value)} placeholder="Ej. GD-45821" /></label>
      <label className="full">Nota de revisión<textarea maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} placeholder={isAdjustment ? "Explica la diferencia o cambio documental" : "Opcional al confirmar sin cambios"} /></label>
    </div>
    {isCorrection && <div className="receipt-correction-preview"><span>Volumen detectado <strong>{formatLiters(movement.originalLiters ?? movement.liters)}</strong></span><i>→</i><span>Volumen conciliado <strong>{formatLiters(correctedLiters)}</strong></span></div>}
    {error && <div className="auth-error" role="alert"><span>!</span>{error}</div>}
    <div className="modal-actions receipt-review-actions">{!alreadyReconciled && <button className="danger-button" type="button" disabled={submitting} onClick={() => void save("reject")}>Rechazar detección</button>}<button className="secondary-button" type="button" disabled={submitting} onClick={onClose}>Cancelar</button><button className="primary-button" type="button" disabled={submitting || alreadyReconciled && !isAdjustment} onClick={() => void save(alreadyReconciled || isCorrection ? "correct" : "approve")}>{submitting ? "Guardando…" : alreadyReconciled ? "Guardar ajuste" : isCorrection ? "Corregir y confirmar" : "Confirmar recepción"}</button></div>
  </section></div>;
}

function ManualReceiptDialog({ onClose, onSaved }: { onClose: () => void; onSaved: (message: string) => void }) {
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [requestId] = useState(clientRequestId);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(""); setSubmitting(true);
    const form = new FormData(event.currentTarget);
    const occurredAt = new Date(String(form.get("occurredAt")));
    const liters = Number(String(form.get("liters")).replace(",", "."));
    try {
      const response = await fetch("/api/fuel-history/receipts/manual", {
        method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId,
          occurredAt: occurredAt.toISOString(),
          liters,
          documentReference: String(form.get("documentReference")),
          source: String(form.get("source")),
          note: String(form.get("note")),
        }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "No fue posible registrar la recepción.");
      onSaved(`Recepción manual de ${formatLiters(liters)} incorporada al inventario conciliado.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No fue posible registrar la recepción.");
      setSubmitting(false);
    }
  };
  return <div className="modal-backdrop" role="presentation"><section className="modal receipt-review-modal" role="dialog" aria-modal="true" aria-label="Registrar recepción manual">
    <button className="modal-close" type="button" onClick={onClose} aria-label="Cerrar">×</button>
    <form onSubmit={submit}><ModalIntro eyebrow="ENTRADA AUTORIZADA" title="Registrar recepción manual" detail="Úsalo cuando exista respaldo documental o la detección automática no haya capturado correctamente la entrega." />
      <div className="form-grid receipt-review-form">
        <label>Fecha y hora<input name="occurredAt" type="datetime-local" defaultValue={dateTimeLocalValue(new Date())} max={dateTimeLocalValue(new Date())} required /></label>
        <label>Volumen recibido (L)<input name="liters" type="number" min="0.1" max={TANK_CAPACITY_LITERS} step="0.1" inputMode="decimal" placeholder="1005,8" required /></label>
        <label>Guía, factura o referencia<input name="documentReference" maxLength={120} placeholder="Ej. GD-45821" required /></label>
        <label>Proveedor u origen<input name="source" maxLength={80} placeholder="Ej. Camión proveedor" /></label>
        <label className="full">Nota de recepción<textarea name="note" minLength={5} maxLength={500} placeholder="Identifica el camión, proveedor o circunstancia de la entrega" required /></label>
      </div>
      <div className="form-note"><span>i</span>La recepción quedará confirmada por tu usuario. El nivel OCIO cercano se conservará como evidencia independiente.</div>
      {error && <div className="auth-error" role="alert"><span>!</span>{error}</div>}
      <div className="modal-actions"><button className="secondary-button" type="button" onClick={onClose} disabled={submitting}>Cancelar</button><button className="primary-button" disabled={submitting}>{submitting ? "Registrando…" : "Registrar y confirmar"}</button></div>
    </form>
  </section></div>;
}

function isReconciledReceipt(movement: FuelMovement) {
  return movement.reviewStatus !== "pending" && movement.reviewStatus !== "rejected";
}

function receiptReviewCopy(status: FuelMovement["reviewStatus"]) {
  if (status === "pending") return "Pendiente de revisión";
  if (status === "approved") return "Confirmada";
  if (status === "corrected") return "Corregida y confirmada";
  if (status === "rejected") return "Rechazada";
  return "No requiere revisión";
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
  [...movements].filter((movement) => movement.type === "receipt"
    ? isReconciledReceipt(movement)
    : movement.classification === "standard")
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)).forEach((movement) => {
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
  return [...buckets.values()];
}

function niceFuelAxisMaximum(value: number) {
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(1, value)));
  const normalized = value / magnitude;
  const rounded = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return rounded * magnitude;
}

function fuelAxisTicks(maximum: number) {
  return [1, .75, .5, .25, 0].map((ratio) => maximum * ratio);
}

function fuelLevelPercent(level: number, capacity: number) {
  return Math.min(98, Math.max(2, level / Math.max(1, capacity) * 100));
}

function dateInputValue(date: Date) {
  const year = date.getFullYear();
  return `${year}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function dateTimeLocalValue(date: Date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
function formatAlertBadge(count: number) { return count > 99 ? "99+" : String(count); }
const formatCompactLiters = formatLiters;
function formatHistoryDate(value: string) { return formatSiteDate(value); }
function formatAlertDate(value: string) { return formatSiteDate(value); }
function movementToTransaction(item: FuelMovement): Transaction {
  const parts = item.detail.split(" · ").map((part) => part.trim()).filter(Boolean);
  const pumpEnablement = item.classification === "pump_enablement";
  const unauthorized = /no autorizado|bypass/u.test(`${item.detail} ${item.source}`.toLocaleLowerCase("es-CL"));
  const exceptional = unauthorized || item.isMaster === true || (parts[1]?.toLocaleLowerCase("es-CL").includes("excepcional") ?? false);
  const closeReason = parts.find((part) => part.startsWith("Cierre:"))?.slice(7).trim() ?? "";
  const interrupted = /ble|fault|falla|timeout|persistence/u.test(closeReason.toLowerCase());
  const detailOperator = parts[0] && parts[0] !== item.operatorId ? parts[0] : "";
  const detailEquipment = parts[1] && parts[1] !== item.equipmentId ? parts[1] : "";
  const adoptionMovement = item.assistedMode || item.adoptionStage === "assisted" || item.adoptionStage === "rfid_only";
  const manualMovement = Boolean(item.manualModeSessionId) && !adoptionMovement;
  const adoptionEquipment = manualMovement ? "Modo manual · sin equipo validado" : adoptionMovement && item.authorizationEvidence === "rfid_only"
    ? "Equipo aún no validado · ruta de adopción"
    : adoptionMovement && item.authorizationEvidence === "assisted" ? "Aprendizaje asistido" : "";
  const adoptionValidation = manualMovement ? item.isMaster ? "Credencial maestra · modo manual" : item.operatorId ? "RFID · modo manual" : "Modo manual · sin operador identificado"
    : item.authorizationEvidence === "full" ? "RFID + MIM + asociación"
    : item.authorizationEvidence === "rfid_only" ? "RFID · operador identificado"
      : item.authorizationEvidence === "assisted" ? "Sesión asistida · evidencia en aprendizaje"
        : item.authorizationEvidence === "master" ? "Credencial maestra"
          : item.authorizationEvidence === "unauthorized" ? "K24 · bypass detectado" : "RFID + BLE";
  return {
    id: item.id,
    occurredAt: item.occurredAt,
    time: formatHistoryDate(item.occurredAt),
    operator: pumpEnablement ? item.operatorName || "Bomba habilitada" : unauthorized ? "Sin operador autorizado" : item.operatorName || detailOperator || "Operador no disponible",
    equipment: pumpEnablement ? "Sin despacho posterior" : unauthorized ? "Sin equipo autorizado" : exceptional ? "Carga de emergencia sin equipo validado" : adoptionEquipment || item.equipmentName || detailEquipment || "Equipo no disponible",
    liters: item.liters,
    duration: "—",
    status: pumpEnablement ? "Habilitación de bomba" : exceptional ? "Excepcional" : interrupted ? "Interrumpida" : "Completada",
    validation: pumpEnablement ? "K24 · sin flujo posterior" : interrupted ? "Cierre de seguridad" : adoptionValidation,
    source: item.source,
    manualModeSessionId: item.manualModeSessionId,
  };
}
function csvCell(value: unknown) { return `"${String(value).replaceAll('"', '""')}"`; }

function clientRequestId() {
  const webCrypto = typeof globalThis.crypto === "object" ? globalThis.crypto : null;
  if (webCrypto && typeof webCrypto.randomUUID === "function") return webCrypto.randomUUID();
  if (webCrypto && typeof webCrypto.getRandomValues === "function") {
    const bytes = webCrypto.getRandomValues(new Uint8Array(16));
    return `local-${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
  }
  return `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

function TransactionTable({ items, onOpen, compact = false, emptyDetail = "Prueba con otro término de búsqueda." }: { items: Transaction[]; onOpen: (id: string) => void; compact?: boolean; emptyDetail?: string }) {
  return (
    <div className="data-table-wrap">
      <table className="data-table">
        <thead><tr><th>Transacción</th><th>Equipo / operador</th><th>Litros</th>{!compact && <th>Duración</th>}<th>Estado</th><th><span className="sr-only">Acción</span></th></tr></thead>
        <tbody>{items.map((item) => <tr key={item.id}>
          <td><strong>{item.id}</strong><small>{formatSiteDate(item.occurredAt)}</small></td>
          <td className="transaction-equipment"><strong>{item.equipment}</strong><small>{item.operator}</small></td>
          <td className="liters"><strong>{formatVolume(item.liters)} L</strong><small>{item.validation}</small></td>
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
  const statusClass = status === "Habilitación de bomba" ? "habilitacion-bomba" : status.toLowerCase();
  return <span className={`status-badge ${statusClass}`}><i />{status}</span>;
}

function Operators({ operators, search, isProviderAdmin, onSearch, onToggle, onArchive, onDelete, onReplace, onCredentials }: { operators: Operator[]; search: string; isProviderAdmin: boolean; onSearch: (value: string) => void; onToggle: (item: Operator) => void; onArchive: (item: Operator, archived: boolean) => void; onDelete: (item: Operator) => void; onReplace: (item: Operator) => void; onCredentials: () => void }) {
  const [scope, setScope] = useState<"current" | "archived">("current");
  const scoped = operators.filter((item) => scope === "archived" ? Boolean(item.archivedAt) : !item.archivedAt);
  const filtered = scoped.filter((item) => `${item.name} ${item.rut} ${item.credential}`.toLowerCase().includes(search.toLowerCase()));
  return <div className="stack"><section className="filter-panel panel"><SearchBar value={search} onChange={onSearch} placeholder="Buscar operador, RUT o credencial" /><HistorySelect label="Operadores" scope={scope} archivedCount={operators.filter((item) => item.archivedAt).length} onChange={setScope} /><div className="summary-chips"><span><strong>{operators.filter((item) => !item.archivedAt && item.active).length}</strong> activos</span><span><strong>{operators.filter((item) => !item.archivedAt && item.credentialIsMaster && item.credentialActive).length}</strong> tarjeta maestra</span></div></section>{filtered.length > 0 ? <section className="entity-grid">{filtered.map((item) => <article className={`entity-card panel ${item.archivedAt ? "archived" : ""}`} key={item.id}><div className="entity-head"><span className="large-avatar">{initials(item.name)}</span><div><h3>{item.name}</h3><p>{item.rut}</p></div>{!item.archivedAt && <button className={`switch ${item.active ? "on" : ""}`} aria-label={`${item.active ? "Desactivar" : "Activar"} a ${item.name}`} onClick={() => onToggle(item)}><span /></button>}</div><div className="entity-details"><span><small>{item.credentialIsMaster ? "Tarjeta maestra" : "Credencial"}</small><strong>{item.credential}</strong></span><span><small>{item.archivedAt ? "Archivado" : "Último uso"}</small><strong>{item.archivedAt ? formatArchivedDate(item.archivedAt) : item.lastUse}</strong></span></div><div className="entity-footer"><span className={item.archivedAt || !item.active || !item.credentialActive ? "muted-text" : item.credentialIsMaster ? "master-credential-state" : "active-text"}><i />{item.archivedAt ? "Histórico" : !item.credentialActive ? "Credencial desactivada" : item.credentialIsMaster ? "Maestra de emergencia" : item.active ? "Habilitado" : "Desactivado"}</span><div className="entity-actions">{item.archivedAt ? <><button className="text-button" onClick={() => onArchive(item, false)}>Restaurar</button>{isProviderAdmin && <button className="text-button danger-text" onClick={() => onDelete(item)}>Eliminar definitivamente</button>}</> : <>{item.credential === "Sin enrolar" || !isProviderAdmin ? <button className="text-button" onClick={onCredentials}>{item.credential === "Sin enrolar" ? "Asignar RFID" : "Ver RFID"}</button> : <button className="text-button" onClick={() => onReplace(item)}>Reemplazar RFID</button>}<button className="text-button archive-text" onClick={() => onArchive(item, true)}>Archivar</button></>}</div></div></article>)}</section> : <section className="panel"><EmptyState title={scope === "archived" ? "Sin operadores pasados" : "No encontramos operadores"} detail={scope === "archived" ? "Los operadores archivados aparecerán aquí sin afectar la operación diaria." : "Prueba con otro nombre, RUT o credencial."} /></section>}</div>;
}

function RfidCredentialsView({ credentials, operators, isProviderAdmin, onIdentify, onCreate, onAssign, onUnassign, onDelete }: { credentials: RfidCredential[]; operators: Operator[]; isProviderAdmin: boolean; onIdentify: () => void; onCreate: () => void; onAssign: (credentialId?: string) => void; onUnassign: (credentialId: string) => void; onDelete: (credentialId: string) => void }) {
  const [section, setSection] = useState<"inventory" | "assignments">("inventory");
  const [query, setQuery] = useState("");
  const assigned = credentials.filter((item) => item.operatorId);
  const filtered = credentials.filter((item) => `${item.credentialId} ${item.operatorName ?? ""}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="stack rfid-credentials-page">
    <section className="rfid-overview panel"><div className="rfid-overview-copy"><span className="rfid-overview-mark">⌁</span><div><span className="eyebrow">INVENTARIO LOCAL SINCRONIZADO</span><h2>{credentials.length} {credentials.length === 1 ? "credencial RFID" : "credenciales RFID"}</h2><p>{isProviderAdmin ? "Los cambios se replican en el PLC para mantener la autorización offline." : "Consulta y vincula credenciales existentes. Los tags nuevos los enrola el proveedor tecnológico."}</p></div></div><div className="summary-chips"><span><strong>{assigned.length}</strong> asignadas</span><span><strong>{credentials.filter((item) => item.credentialIsMaster && item.credentialActive).length}</strong> maestra</span></div><button className="secondary-button compact" type="button" onClick={onIdentify}>⌁ Identificar credencial RFID</button></section>
    <section className="rfid-section-tabs panel"><div className="segmented-control"><button className={section === "inventory" ? "active" : ""} type="button" onClick={() => setSection("inventory")}>Credenciales</button><button className={section === "assignments" ? "active" : ""} type="button" onClick={() => setSection("assignments")}>Vinculaciones</button></div>{section === "inventory" ? <SearchBar value={query} onChange={setQuery} placeholder="Buscar tag u operador" /> : <button className="primary-button compact" type="button" onClick={() => onAssign()}>＋ Nueva vinculación</button>}</section>
    {section === "inventory" ? (filtered.length ? <section className="rfid-inventory panel"><div className="rfid-list-head"><span>Credencial</span><span>Tipo</span><span>Operador</span><span>Estado</span><span /></div>{filtered.map((item) => <article className="rfid-list-row" key={item.credentialId}><div className="rfid-identity"><span className={`rfid-mini ${item.credentialIsMaster ? "master" : ""}`}>⌁</span><div><strong>{formatCredentialId(item.credentialId)}</strong><small>Enrolada {formatCompactDate(item.createdAt)}</small></div></div><span className={`rfid-kind ${item.credentialIsMaster ? "master" : ""}`}>{item.credentialIsMaster ? "Maestra" : "Normal"}</span><div className="rfid-owner"><strong>{item.operatorName ?? "Sin asignar"}</strong><small>{item.operatorRut ?? "Disponible para vincular"}</small></div><span className={item.credentialActive ? item.operatorId ? "active-text" : "rfid-available" : "muted-text"}><i />{item.credentialActive ? item.operatorId ? "Operativa" : "Disponible" : "Inactiva"}</span><div className="rfid-row-actions"><button className="text-button" type="button" onClick={() => onAssign(item.credentialId)}>{item.operatorId ? "Cambiar" : "Asignar"}</button>{isProviderAdmin && <button className="text-button danger-text" type="button" onClick={() => onDelete(item.credentialId)}>Eliminar</button>}</div></article>)}</section> : <section className="panel"><EmptyState title="Sin credenciales RFID" detail={isProviderAdmin ? "Enrola el primer tag para incorporarlo al inventario local." : "El administrador del proveedor tecnológico debe enrolar el primer tag."} />{isProviderAdmin && <div className="empty-action"><button className="primary-button" type="button" onClick={onCreate}>＋ Enrolar credencial</button></div>}</section>) : (assigned.length ? <section className="association-list rfid-association-list">{assigned.map((item) => <article className="association-row panel" key={item.credentialId}><div className="association-person rfid-association-tag"><span className={`rfid-mini ${item.credentialIsMaster ? "master" : ""}`}>⌁</span><div><small>CREDENCIAL RFID</small><strong>{formatCredentialId(item.credentialId)}</strong><span>{item.credentialIsMaster ? "Tarjeta maestra" : "Credencial normal"}</span></div></div><div className="association-link"><span /><b>↔</b><span /></div><div className="association-equipment rfid-association-operator"><span className="large-avatar small">{initials(item.operatorName ?? "")}</span><div><small>OPERADOR</small><strong>{item.operatorName}</strong><span>{item.operatorRut}</span></div></div><div className="association-state"><span className={item.credentialActive && item.operatorActive && !item.operatorArchivedAt ? "active-text" : "muted-text"}><i />{item.credentialActive && item.operatorActive && !item.operatorArchivedAt ? "Vigente" : "Sin autorización"}</span></div><div className="association-actions"><button className="text-button" type="button" onClick={() => onAssign(item.credentialId)}>Cambiar</button>{!item.credentialIsMaster && <button className="text-button archive-text" type="button" onClick={() => onUnassign(item.credentialId)}>Desvincular</button>}</div></article>)}</section> : <section className="panel"><EmptyState title="Sin vinculaciones RFID" detail={`Hay ${operators.filter((item) => !item.archivedAt && item.active).length} operadores vigentes disponibles para asociar.`} /><div className="empty-action"><button className="primary-button" type="button" onClick={() => onAssign()}>＋ Nueva vinculación</button></div></section>)}
  </div>;
}

function MimEnrollmentView({ candidates, scan, nowMs, onEnroll, onRefresh }: { candidates: EnrollmentCandidate[]; scan: EquipmentScan | null; nowMs: number; onEnroll: (moduleId: string) => void; onRefresh: () => void }) {
  const pendingCandidates = candidates.filter((candidate) => candidate.status !== "enrolled");
  const activeCandidates = pendingCandidates.filter((candidate) => candidate.status === "pending" || candidate.status === "enrolling");
  const availableCandidates = pendingCandidates.filter((candidate) => candidate.status === "detected");
  return <div className="stack mim-enrollment-page">
    <section className="panel mim-enrollment-summary" aria-label="Capacidad de enrolamiento MIM">
      <div><span className="eyebrow">ENROLAMIENTO INDEPENDIENTE POR MÓDULO</span><h2>Enlaza varios MIM al mismo tiempo</h2></div>
      <div className="summary-chips"><span><strong>{availableCandidates.length}</strong> {availableCandidates.length === 1 ? "disponible" : "disponibles"}</span><span><strong>{activeCandidates.length}</strong> en proceso</span></div>
    </section>
    <section className="panel bluetooth-enrollment">
      <div className="enrollment-copy"><span className="bluetooth-mark">W</span><div><span className="eyebrow">ENROLAMIENTO MIM POR WI-FI · ACTUALIZACIÓN CADA 5 S</span><h2>Energiza uno o varios Módulos Identificadores de Máquina (MIM)</h2><button className="secondary-button scan-refresh-button" type="button" onClick={onRefresh}><span className="scan-refresh-icon"><RefreshArrow /></span>Actualizar lectura de MIMs</button>{scan?.status === "completed" && <span className="scan-result completed">Última búsqueda: {scan.verified} {scan.verified === 1 ? "MIM verificado" : "MIM verificados"}</span>}{scan?.status === "failed" && <span className="scan-result failed">{scan.error ?? "La última búsqueda no se pudo completar"}</span>}</div></div>
      <div className="candidate-list" aria-live="polite">
        {pendingCandidates.length === 0 && <div className="candidate-scanning"><span className="scan-rings" /><div><strong>Esperando MIM nuevos…</strong><small>Puedes energizar varios a la vez. Se conectarán solos a la red Wi-Fi privada del PLC; no necesitas configurar el teléfono.</small></div></div>}
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
  </div>;
}

function EquipmentView({ equipment, candidates, search, nowMs, onSearch, onOpen }: { equipment: Equipment[]; candidates: EnrollmentCandidate[]; search: string; nowMs: number; onSearch: (value: string) => void; onOpen: (id: string) => void }) {
  const [scope, setScope] = useState<"current" | "archived">("current");
  const scoped = equipment.filter((item) => scope === "archived" ? Boolean(item.archivedAt) : !item.archivedAt);
  const filtered = scoped.filter((item) => `${item.name} ${item.kind} ${item.module}`.toLowerCase().includes(search.toLowerCase()));
  return <div className="stack">
    <section className="filter-panel panel"><SearchBar value={search} onChange={onSearch} placeholder="Buscar equipo, tipo o módulo" /><HistorySelect label="Equipos" scope={scope} archivedCount={equipment.filter((item) => item.archivedAt).length} onChange={setScope} /><div className="summary-chips"><span><strong>{equipment.filter((item) => !item.archivedAt && item.active && !item.assignmentExpired).length}</strong> habilitados</span><span><strong>{equipment.filter((item) => !item.archivedAt && item.assignmentExpired).length}</strong> vencidos</span></div></section>
    {filtered.length > 0 ? <section className="entity-grid equipment-grid">{filtered.map((item) => {
      const expired = Boolean(item.assignmentExpired);
      const expiringSoon = assignmentExpiresWithin24Hours(item, nowMs);
      const signal = candidates.find((entry) => entry.moduleId === item.module);
      const connected = Boolean(signal && mimSignalIsFresh(signal, nowMs));
      return <article className={`entity-card panel ${item.archivedAt ? "archived" : ""} ${expired ? "assignment-expired" : ""}`} key={item.id}>
        <div className="entity-head"><span className="equipment-icon">{item.kind.slice(0, 2).toUpperCase()}</span><div><span className={`condition ${expired ? "expired" : item.condition.toLowerCase()}`}>{expired ? "Vencido" : item.condition}</span><h3>{item.name}</h3><p>{item.kind}</p></div></div>
        <div className="module-row"><div><small>Módulo · fundo</small><strong>{item.module}</strong><small>{item.siteId || "Sin fundo asignado"}</small></div><div className="module-telemetry">{signal && <div className={`live-signal ${connected ? "" : "offline"}`} title={`Última señal recibida ${formatMimSignalAge(signal.lastSeen, nowMs)}`}><i /><span><strong>{connected ? `${signal.rssi} dBm` : "Sin señal reciente"}</strong><small>{connected ? "Actualiza cada 5 s" : formatMimSignalAge(signal.lastSeen, nowMs)}</small></span></div>}</div></div>
        {item.expiry && <div className={`expiry-note ${expired ? "expired" : expiringSoon ? "expiring" : ""}`}><span>◷</span>{expired ? "Venció el " : expiringSoon ? "Vence en menos de 24 h · " : "Vigente hasta el "}{formatAssignmentDate(item.expiry)}</div>}
        <div className="entity-footer"><span className={item.archivedAt || !item.active || expired ? "muted-text" : "active-text"}><i />{item.archivedAt ? "Histórico" : expired ? "Carga bloqueada por vencimiento" : item.active ? "Disponible para carga" : "Fuera de servicio"}</span><button className="text-button equipment-detail-link" type="button" onClick={() => onOpen(item.id)}>Ver ficha</button></div>
      </article>;
    })}</section> : <section className="panel"><EmptyState title={scope === "archived" ? "Sin equipos pasados" : "Aún no hay equipos enrolados"} detail={scope === "archived" ? "Los equipos archivados aparecerán aquí sin afectar la operación diaria." : "Usa Enlazar nuevo MIM para detectar y asignar uno o varios módulos."} /></section>}
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
  const [originFilter, setOriginFilter] = useState<"all" | "original" | "reopened">("all");
  const [sort, setSort] = useState<"priority" | "recent">("priority");
  const activeAlerts = alerts.filter((item) => item.status !== "resolved");
  const priorityCounts = Object.fromEntries(alertPriorities.map((priority) => [priority, activeAlerts.filter((item) => item.priority === priority).length])) as Record<AlertPriority, number>;
  const priorityRank: Record<AlertPriority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
  const visible = alerts.filter((item) => {
    const priorityMatches = priorityFilter === "all" || item.priority === priorityFilter;
    const statusMatches = statusFilter === "all" || (statusFilter === "active" ? item.status !== "resolved" : item.status === statusFilter);
    const originMatches = originFilter === "all" || (originFilter === "reopened" ? item.reopenNumber > 0 : item.reopenNumber === 0);
    return priorityMatches && statusMatches && originMatches;
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
        <div className="alert-feed-head"><div><strong>{visible.length}</strong><span>resultados · {inProgress} tomando acción</span></div><div className="alert-feed-controls"><label>Estado<select aria-label="Filtrar alertas por estado" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}><option value="active">Abiertas</option><option value="all">Todas</option><option value="pending">Pendientes</option><option value="in_progress">Tomando acción</option><option value="resolved">Resueltas</option></select></label><label>Origen<select aria-label="Filtrar alertas por origen" value={originFilter} onChange={(event) => setOriginFilter(event.target.value as typeof originFilter)}><option value="all">Todas</option><option value="reopened">Reabiertas</option><option value="original">Originales</option></select></label><label>Orden<select aria-label="Ordenar alertas" value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}><option value="priority">Prioridad</option><option value="recent">Más recientes</option></select></label></div></div>
        {visible.map((item) => <article className={`alert-row priority-${item.priority} ${item.status === "resolved" ? "acknowledged" : ""} ${item.reopenNumber > 0 ? "reopened" : ""}`} key={item.id}><span className="alert-priority-mark" aria-hidden="true">{item.priority === "urgent" ? "!" : item.priority === "high" ? "↑" : item.priority === "medium" ? "•" : "↓"}</span><div><div className="alert-title-row"><strong>{item.title}</strong>{item.reopenNumber > 0 && <span className="alert-reopened-badge">Reabierta · ciclo {item.reopenNumber}</span>}<span className={`priority-badge ${item.priority}`}>{alertPriorityCopy[item.priority]}</span><span className={`alert-status-badge ${item.status}`}>{alertStatusCopy[item.status]}</span></div><p>{item.detail}</p><div className="alert-row-meta"><time>{formatAlertDate(item.time)}</time>{canManage && <span>{item.comments?.length ?? 0} {(item.comments?.length ?? 0) === 1 ? "registro" : "registros"}</span>}</div></div><button className="secondary-button small" onClick={() => onOpen(item.id)}>Abrir alerta</button></article>)}
        {visible.length === 0 && <EmptyState title={alerts.length === 0 ? "Sin alertas registradas" : "Sin alertas para estos filtros"} detail={alerts.length === 0 ? "Las fallas y advertencias del controlador edge aparecerán aquí." : "Cambia el estado o selecciona otra prioridad."} />}
      </section>
      <aside className="panel alert-guide"><span className="eyebrow">Resumen</span><h2>Estado de las alertas</h2><div className="status-mini-dashboard"><div><i className="pending" /><span><strong>{alerts.filter((item) => item.status === "pending").length}</strong>Pendientes</span></div><div><i className="in-progress" /><span><strong>{inProgress}</strong>Tomando acción</span></div><div><i className="resolved" /><span><strong>{alerts.filter((item) => item.status === "resolved").length}</strong>Resueltas</span></div></div><details className="context-help"><summary>Cómo gestionar una alerta</summary><ol><li>Abre la alerta y define su criticidad.</li><li>Guarda comentarios mientras se trabaja.</li><li>Selecciona “Resuelta” sólo al terminar.</li><li>Si reaparece, reábrela como un ciclo nuevo.</li></ol></details>{!canManage && <small>Tu perfil puede consultar alertas; el historial de atención está restringido.</small>}</aside>
    </div>
  </div>;
}

const permissionCopy: Record<Permission, string> = {
  view_dashboard: "Ver resumen operacional",
  view_transactions: "Consultar y exportar cargas",
  manage_receipts: "Conciliar y registrar recepciones",
  manage_alerts: "Atender y cerrar alertas",
  manage_operators: "Gestionar operadores RFID",
  manage_equipment: "Gestionar equipos",
  manage_associations: "Gestionar asociaciones",
  manage_users: "Administrar usuarios y permisos",
  manage_system: "Administrar sistema y respaldos",
};
const roleCopy: Record<UserRole, string> = { master: "Usuario maestro", administrator: "Administrador", supervisor: "Supervisor operacional", viewer: "Consulta" };
const rolePreset: Record<Exclude<UserRole, "master">, Permission[]> = {
  administrator: Object.keys(permissionCopy) as Permission[],
  supervisor: ["view_dashboard", "view_transactions", "manage_receipts", "manage_alerts", "manage_operators", "manage_equipment", "manage_associations"],
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
    <section className="panel user-summary"><div><span className="eyebrow">Gobierno de acceso</span><h2>{activeUsers} {activeUsers === 1 ? "cuenta activa" : "cuentas activas"}</h2></div><button className="primary-button" onClick={() => setEditing("new")}>＋ Enrolar usuario</button></section>
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
    <section className="panel recovery-policy"><span className="lock-mark">⌾</span><div><h3>Recuperación en dos niveles</h3><p>El usuario maestro restablece claves temporales para el equipo. Si pierde su propia clave, utiliza el código offline; con acceso físico también puede reprovisionarla en el PLC.</p></div></section>
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

function DataExportView({ exporting, onExport }: { exporting: DataExportDataset | null; onExport: (dataset: DataExportDataset) => Promise<void> }) {
  const exports: Array<{ id: Exclude<DataExportDataset, "all">; mark: string; title: string; description: string; detail: string }> = [
    { id: "voltages", mark: "V", title: "Voltajes de entrada OCIO", description: "Señal medida en la entrada analógica del PLC, antes de convertirla a litros.", detail: "Fecha, volts, ADC y estado" },
    { id: "machine-liters", mark: "L/EQ", title: "Litros por máquina", description: "Litros acumulados y cantidad de cargas por equipo en todo el histórico.", detail: "Incluye cargas sin equipo" },
    { id: "levels", mark: "NL", title: "Niveles históricos", description: "Lecturas cronológicas del estanque registradas por el sensor OCIO.", detail: "Fecha, litros, fuente" },
    { id: "transactions", mark: "TX", title: "Transacciones", description: "Recepciones y despachos con volumen, operador, equipo y evidencia.", detail: "Trazabilidad completa" },
    { id: "users", mark: "US", title: "Usuarios enrolados", description: "Cuentas habilitadas, roles, permisos y último acceso al sistema.", detail: "Sin correos ni claves" },
    { id: "associations", mark: "VX", title: "Vinculaciones operador–equipo", description: "Relaciones vigentes e históricas entre personas y maquinaria.", detail: "Incluye tractores" },
    { id: "operators", mark: "OP", title: "Operadores", description: "Catálogo operacional y estado de enrolamiento de cada operador.", detail: "Sin RUT ni ID RFID" },
    { id: "equipment", mark: "EQ", title: "Equipos", description: "Inventario de tractores, trilladoras y cuatrimotos vinculables.", detail: "Módulo, fundo y vigencia" },
    { id: "credentials", mark: "RF", title: "Enrolamientos RFID", description: "Estado de credenciales por operador, sin exponer sus identificadores.", detail: "Datos sanitizados" },
    { id: "alerts", mark: "AL", title: "Alertas", description: "Eventos de nivel, validación y salud del sistema con su resolución.", detail: "Estado y prioridad" },
  ];
  const busy = exporting !== null;
  return (
    <div className="data-export-layout">
      <section className="panel data-export-hero">
        <div className="data-export-hero-mark" aria-hidden="true">DATA</div>
        <div>
          <span className="eyebrow">Exportación consolidada</span>
          <h2>Base operacional completa</h2>
          <p>Voltajes, niveles, litros por máquina, movimientos y registros operacionales en un único archivo estructurado.</p>
          <div className="data-export-tags"><span>JSON</span><span>Solo lectura</span><span>11 colecciones</span></div>
        </div>
        <button className="primary-button data-export-all" type="button" disabled={busy} onClick={() => void onExport("all")}>
          <span aria-hidden="true">↓</span>{exporting === "all" ? "Preparando…" : "Exportar base completa"}
        </button>
      </section>

      <section className="data-export-grid" aria-label="Conjuntos disponibles para exportar">
        {exports.map((item) => (
          <article className="panel data-export-card" key={item.id} aria-busy={exporting === item.id}>
            <div className="data-export-card-heading"><span className="data-export-card-mark" aria-hidden="true">{item.mark}</span><span className="data-format">CSV</span></div>
            <h2>{item.title}</h2>
            <p>{item.description}</p>
            <div className="data-export-card-footer"><small>{item.detail}</small><button className="secondary-button small" type="button" disabled={busy} onClick={() => void onExport(item.id)}><span aria-hidden="true">↓</span>{exporting === item.id ? "Preparando…" : "Exportar"}</button></div>
          </article>
        ))}
      </section>

      <section className="panel data-export-safety">
        <span aria-hidden="true">✓</span>
        <div><strong>Exportación segura y sin importación</strong><p>Las descargas no modifican registros. Se excluyen contraseñas, correos, RUT, secretos e identificadores RFID, y cada exportación queda registrada en la auditoría del sistema.</p></div>
      </section>
    </div>
  );
}

function TechnologyAdoptionSystemPanel({ dashboard, loading, canManage, onRefresh, onOpen }: { dashboard: TechnologyAdoptionDashboard | null; loading: boolean; canManage: boolean; onRefresh: () => Promise<void>; onOpen: () => void }) {
  const [starting, setStarting] = useState(false);
  const [deactivating, setDeactivating] = useState(false);
  const [confirmingDeactivation, setConfirmingDeactivation] = useState(false);
  const [error, setError] = useState("");
  if (dashboard?.settings.programStatus === "completed") return null;
  const active = dashboard?.settings.programStatus === "active";
  const stage = dashboard?.settings.stage ?? "full";
  const restoring = !active && Boolean(dashboard && dashboard.settings.revision > 1 && !dashboard.edgeApplication?.applied);
  const start = async () => {
    setStarting(true); setError("");
    try {
      const response = await fetch("/api/technology-adoption/start", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "No fue posible iniciar la adopción tecnológica.");
      await onRefresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No fue posible iniciar la adopción tecnológica.");
    } finally {
      setStarting(false);
    }
  };
  const deactivate = async () => {
    setDeactivating(true); setError("");
    try {
      const response = await fetch("/api/technology-adoption/deactivate", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "No fue posible desactivar la adopción tecnológica.");
      await onRefresh();
      setConfirmingDeactivation(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No fue posible desactivar la adopción tecnológica.");
    } finally {
      setDeactivating(false);
    }
  };
  return <>
    <section className={`panel adoption-system-card ${active ? `active stage-${stage}` : "inactive"}`}>
      <span className="adoption-system-mark" aria-hidden="true">AT</span>
      <div className="adoption-system-copy"><span className="eyebrow">Adopción tecnológica</span><h2>{active ? adoptionStageCopy[stage].title : "Aprendizaje gradual disponible"}</h2><p>{active ? "El programa está visible al final de Operación mientras el equipo completa su aprendizaje." : "Inicia una ruta temporal de aprendizaje asistido, identidad RFID y trazabilidad completa. Al terminar, sus pantallas desaparecerán automáticamente."}</p>{error && <div className="auth-error" role="alert"><span>!</span>{error}</div>}</div>
      {restoring && <div className="form-note warning" role="status"><span>!</span>Desactivación guardada. Esperando que el controlador confirme la trazabilidad completa; mientras tanto, la política anterior podría seguir aplicada.</div>}
      <div className="adoption-system-action">{active ? <><span><i />Programa activo</span><button className="secondary-button compact" type="button" onClick={onOpen}>Abrir adopción tecnológica</button>{canManage && <button className="text-button danger-text" type="button" onClick={() => { setError(""); setConfirmingDeactivation(true); }}>Desactivar etapa de adopción tecnológica</button>}</> : canManage ? <button className="primary-button" type="button" disabled={loading || starting || restoring || !dashboard} onClick={() => void start()}>{starting ? "Iniciando…" : "Iniciar etapa de adopción tecnológica"}</button> : <small>Requiere administración del sistema</small>}</div>
    </section>
    {confirmingDeactivation && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !deactivating && setConfirmingDeactivation(false)}><section className="modal adoption-deactivation-modal" role="dialog" aria-modal="true" aria-labelledby="adoption-deactivation-title"><button className="modal-close" type="button" disabled={deactivating} onClick={() => setConfirmingDeactivation(false)} aria-label="Cerrar">×</button><div className="delete-confirm"><span className="danger-mark">!</span><div className="modal-intro"><span className="eyebrow">Configuración protegida</span><h2 id="adoption-deactivation-title">Desactivar etapa de adopción tecnológica</h2><p>Esta acción corrige un inicio accidental sin borrar el historial.</p></div><p>Se cancelarán las sesiones asistidas abiertas o programadas y se solicitará al controlador volver a trazabilidad completa. Confirmaremos aquí cuando aplique el cambio. Las cargas ya registradas conservarán su evidencia original.</p><div className="form-note warning"><span>!</span>Un período de modo manual independiente continuará activo y debe administrarse por separado en Sistema.</div>{error && <div className="auth-error" role="alert"><span>!</span>{error}</div>}<div className="modal-actions"><button className="secondary-button" type="button" disabled={deactivating} onClick={() => setConfirmingDeactivation(false)}>Mantener activa</button><button className="danger-button" type="button" disabled={deactivating} onClick={() => void deactivate()}>{deactivating ? "Desactivando…" : "Desactivar y volver a operación completa"}</button></div></div></section></div>}
  </>;
}

function SystemView({ powerRevision, onOpenAlert, nowMs, edge, sensor, adoption, adoptionLoading, online, canManage, canManageCommissioning, canManageAdoption, canManageManualMode, canTestPump, onRefresh, onRefreshAdoption, onOpenAdoption, onReset }: { powerRevision: string; onOpenAlert: (id: string) => void; nowMs: number; edge: FuelHistoryResponse["edge"]; sensor: FuelHistoryResponse["sensor"] | null; adoption: TechnologyAdoptionDashboard | null; adoptionLoading: boolean; online: boolean; canManage: boolean; canManageCommissioning: boolean; canManageAdoption: boolean; canManageManualMode: boolean; canTestPump: boolean; onRefresh: () => Promise<void>; onRefreshAdoption: () => Promise<void>; onOpenAdoption: () => void; onReset: (password: string) => Promise<void> }) {
  return <SystemWorkspace sections={[
    { id: "health", label: "Estado del sistema", content: <SystemHealthPanel edge={edge} sensor={sensor} online={online} nowMs={nowMs} onRefresh={onRefresh} /> },
    { id: "power", label: "Suministro eléctrico", content: <PowerSupplyView alertRevision={powerRevision} online={online} reportedAt={edge?.occurredAt} onOpenAlert={onOpenAlert} /> },
    { id: "maintenance", label: "Calibración y mantenimiento", content: <div className="sys-tools-grid"><div className="sys-tools-stack"><OcioCalibrationPanel nowMs={nowMs} canManage={canManage} onRefresh={onRefresh} />{canManage && <BluetoothCalibration />}{canManageCommissioning && <InventoryBalancePanel nowMs={nowMs} />}</div><aside className="sys-tools-stack">{canTestPump && <RelayTestPanel edge={edge} online={online} onRefresh={onRefresh} />}{canManageCommissioning && <CommissioningPanel onReset={onReset} />}<section className="panel protected-card"><span className="lock-mark">⌾</span><div><h3>Configuración protegida</h3><p>Calibraciones y pruebas físicas requieren permiso de administración del sistema.</p></div></section></aside></div> },
    { id: "operation", label: "Operación y permisos", content: <div className="sys-tools-stack"><TechnologyAdoptionSystemPanel dashboard={adoption} loading={adoptionLoading} canManage={canManageAdoption} onRefresh={onRefreshAdoption} onOpen={onOpenAdoption} />{canManageManualMode && <ManualModePanel edge={edge} online={online} onRefresh={onRefresh} />}{!canManageManualMode && <section className="panel protected-card"><div><h3>Operación excepcional</h3><p>Tu perfil no permite programar períodos de modo manual.</p></div></section>}</div> },
  ]} />;
}

function ManualModePanel({ edge, online, onRefresh, variant = "manual" }: { edge: FuelHistoryResponse["edge"]; online: boolean; onRefresh: () => Promise<void>; variant?: "manual" | "adoption" }) {
  const [schedule, setSchedule] = useState<ManualModeSchedule | null>(null);
  const [open, setOpen] = useState(false);
  const [startAt, setStartAt] = useState(() => localDateTimeFromNow(0, 2));
  const [endAt, setEndAt] = useState(() => localDateTimeFromNow(0, 62));
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(0);
  const load = useCallback(async () => {
    const response = await fetch("/api/manual-mode", { credentials: "same-origin", cache: "no-store" });
    const body = await response.json() as { schedule?: ManualModeSchedule | null; error?: string };
    if (!response.ok) throw new Error(body.error ?? "No fue posible consultar el modo manual.");
    setSchedule(body.schedule ?? null);
  }, []);
  useEffect(() => {
    let cancelled = false;
    const refresh = () => { setNow(Date.now()); return load().catch((caught) => !cancelled && setError(caught instanceof Error ? caught.message : "No fue posible consultar el modo manual.")).finally(() => !cancelled && setLoading(false)); };
    refresh();
    const timer = window.setInterval(() => { setNow(Date.now()); refresh(); }, 3000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [load]);
  const hasOpenSchedule = schedule?.status === "scheduled" || schedule?.status === "active";
  const belongsToVariant = schedule?.purpose === (variant === "adoption" ? "adoption_assisted" : "manual");
  const withinWindow = Boolean(schedule && now >= new Date(schedule.startAt).getTime() && now < new Date(schedule.endAt).getTime());
  const physicallyActive = Boolean(belongsToVariant && hasOpenSchedule && withinWindow && online && edge?.state === "manual_mode" && edge.relayEnergized);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true); setError("");
    try {
      const start = new Date(startAt); const end = new Date(endAt);
      if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) throw new Error("El fin debe ser posterior al inicio.");
      const response = await fetch("/api/manual-mode", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startAt: start.toISOString(), endAt: end.toISOString(), purpose: variant === "adoption" ? "adoption_assisted" : "manual" }),
      });
      const body = await response.json() as { schedule?: ManualModeSchedule; error?: string };
      if (!response.ok || !body.schedule) throw new Error(body.error ?? "No fue posible programar el modo manual.");
      setSchedule(body.schedule); setOpen(false); await onRefresh();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "No fue posible programar el modo manual."); }
    finally { setSubmitting(false); }
  };
  const cancel = async () => {
    if (!schedule) return;
    setSubmitting(true); setError("");
    try {
      const response = await fetch(`/api/manual-mode/${encodeURIComponent(schedule.id)}`, { method: "DELETE", credentials: "same-origin" });
      const body = await response.json() as { schedule?: ManualModeSchedule; error?: string };
      if (!response.ok || !body.schedule) throw new Error(body.error ?? "No fue posible cancelar el modo manual.");
      setSchedule(body.schedule); await onRefresh();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "No fue posible cancelar el modo manual."); }
    finally { setSubmitting(false); }
  };
  const status = !belongsToVariant ? hasOpenSchedule ? "Existe otra ventana operacional" : "Sin períodos programados"
    : physicallyActive ? variant === "adoption" ? "Sesión asistida activa: práctica en curso" : "Modo manual activo: bomba habilitada"
    : hasOpenSchedule && withinWindow ? "Esperando confirmación del controlador edge"
      : schedule?.status === "scheduled" ? belongsToVariant && variant === "adoption" ? "Sesión asistida programada" : belongsToVariant ? "Modo manual programado" : "Existe otra ventana operacional"
        : schedule?.status === "cancelled" ? "Último período cancelado"
          : schedule?.status === "completed" ? "Último período completado"
            : schedule?.status === "expired" ? "El período terminó sin activarse"
              : schedule?.status === "failed" ? schedule.error ?? "La activación falló" : "Sin períodos programados";
  return <>
    <section className={`panel manual-mode-card ${variant === "adoption" ? "adoption-assisted" : ""} ${physicallyActive ? "active" : hasOpenSchedule ? "scheduled" : ""}`}>
      <div className="manual-mode-heading"><span className="manual-mode-mark">{variant === "adoption" ? "1" : "M"}</span><div><span className="eyebrow">{variant === "adoption" ? "Aprendizaje en terreno" : "Operación excepcional"}</span><h2>{variant === "adoption" ? "Sesión asistida de adopción" : "Modo manual"}</h2><p>{variant === "adoption" ? "Una ventana aprobada permite practicar la secuencia real: despertar el MIM, presentar el RFID, esperar la confirmación y cargar. Cada intento conserva la mejor evidencia conseguida." : "Durante el período, R0.1 permanece cerrado para surtir normalmente. Si se presenta un tag, los pulsos K24 se imputan a su operador sin interrumpir la bomba."}</p></div><span className={`manual-mode-state ${physicallyActive ? "active" : ""}`}><i />{status}</span></div>
      {schedule && belongsToVariant && <div className="manual-mode-window"><div><small>INICIO</small><strong>{formatAlertDate(schedule.startAt)}</strong></div><span>→</span><div><small>FIN</small><strong>{formatAlertDate(schedule.endAt)}</strong></div><div><small>{schedule.purpose === "adoption_assisted" ? "ACOMPAÑADO POR" : "AUTORIZADO POR"}</small><strong>{schedule.actorName}</strong></div></div>}
      {error && <div className="auth-error" role="alert"><span>!</span>{error}</div>}
      <div className="manual-mode-actions"><button className="primary-button" type="button" disabled={loading || Boolean(hasOpenSchedule) || submitting} onClick={() => { setError(""); setStartAt(localDateTimeFromNow(0, 2)); setEndAt(localDateTimeFromNow(0, 62)); setOpen(true); }}>{loading ? "Consultando…" : variant === "adoption" ? "Programar sesión asistida" : "Programar modo manual"}</button>{hasOpenSchedule && belongsToVariant && <button className="secondary-button" type="button" disabled={submitting} onClick={() => void cancel()}>{submitting ? "Cancelando…" : variant === "adoption" ? "Cancelar sesión" : "Cancelar período"}</button>}</div>
      {hasOpenSchedule && !belongsToVariant && <small className="manual-mode-warning">Ya existe una ventana de {schedule?.purpose === "adoption_assisted" ? "aprendizaje asistido" : "modo manual"}. Debe finalizar o cancelarse antes de programar otra.</small>}
      {!online && hasOpenSchedule && <small className="manual-mode-warning">El período quedó guardado; el PLC lo aplicará al recuperar conexión dentro de la ventana.</small>}
    </section>
    {open && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !submitting && setOpen(false)}><section className="modal manual-mode-modal" role="dialog" aria-modal="true" aria-labelledby="manual-mode-title"><button className="modal-close" type="button" disabled={submitting} onClick={() => setOpen(false)} aria-label="Cerrar">×</button><form onSubmit={submit}><div className="modal-intro"><span className="eyebrow">Administrador o supervisor operacional</span><h2 id="manual-mode-title">{variant === "adoption" ? "Programar sesión asistida" : "Programar modo manual"}</h2><p>{variant === "adoption" ? "Selecciona una ventana con acompañamiento en terreno. El controlador permitirá practicar la secuencia completa y conservará la evidencia conseguida en cada carga." : "Selecciona el inicio y el fin. El controlador cerrará el relé sólo dentro de esa ventana y lo abrirá automáticamente al terminar."}</p></div><div className="form-grid"><label>Inicio<input name="startAt" type="datetime-local" min={localDateTimeFromNow(0)} value={startAt} onChange={(event) => setStartAt(event.target.value)} required /></label><label>Fin<input name="endAt" type="datetime-local" min={startAt || localDateTimeFromNow(0)} value={endAt} onChange={(event) => setEndAt(event.target.value)} required /></label></div><div className="form-note warning"><span>!</span>Durante la ventana la bomba quedará habilitada aun sin tag. Mantén la zona controlada y el acompañamiento presente.</div><div className="form-note success"><span>✓</span>{variant === "adoption" ? "Un RFID válido identifica al operador; si el MIM y la asociación también validan, la carga contará como trazabilidad completa." : "Cada tag válido abre un segmento de consumo independiente; K24 imputará sus litros al operador identificado."}</div>{error && <div className="auth-error" role="alert"><span>!</span>{error}</div>}<div className="modal-actions"><button className="secondary-button" type="button" disabled={submitting} onClick={() => setOpen(false)}>Cancelar</button><button className="primary-button" type="submit" disabled={submitting}>{submitting ? "Programando…" : variant === "adoption" ? "Confirmar sesión asistida" : "Confirmar período manual"}</button></div></form></section></div>}
  </>;
}

function CommissioningPanel({ onReset }: { onReset: (password: string) => Promise<void> }) {
  const [commissioning, setCommissioning] = useState<CommissioningState | null>(null);
  const [dialog, setDialog] = useState<"reset" | "complete" | "reopen" | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const passwordInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/system-settings/commissioning", {
      credentials: "same-origin",
      cache: "no-store",
    });
    const body = await response.json() as { commissioning?: CommissioningState; error?: string };
    if (!response.ok || !body.commissioning) {
      throw new Error(body.error ?? "No fue posible consultar la puesta en marcha.");
    }
    setCommissioning(body.commissioning);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const initial = window.setTimeout(() => {
      load().catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "No fue posible consultar la puesta en marcha.");
      }).finally(() => { if (!cancelled) setLoading(false); });
    }, 0);
    return () => { cancelled = true; window.clearTimeout(initial); };
  }, [load]);

  useEffect(() => {
    if (!dialog) return;
    const focusFrame = window.requestAnimationFrame(() => passwordInput.current?.focus());
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) setDialog(null);
    };
    window.addEventListener("keydown", close);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", close);
    };
  }, [dialog, submitting]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const password = String(data.get("administratorPassword"));
    setSubmitting(true);
    setError("");
    setNotice("");
    try {
      if (dialog === "reset") {
        await onReset(password);
        setNotice("Base reiniciada. Finaliza la PEM cuando la recepción en terreno sea aprobada.");
      } else if (dialog === "complete" || dialog === "reopen") {
        const response = await fetch("/api/system-settings/commissioning", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: dialog,
            password,
            reason: dialog === "reopen" ? String(data.get("reason")).trim() : undefined,
          }),
        });
        const body = await response.json() as { updated?: boolean; commissioning?: CommissioningState; error?: string };
        if (!response.ok || !body.updated || !body.commissioning) {
          throw new Error(body.error ?? "No fue posible cambiar la puesta en marcha.");
        }
        setCommissioning(body.commissioning);
        setNotice(dialog === "complete"
          ? "PEM finalizada: el reinicio de carga y nivel quedó bloqueado."
          : `PEM reabierta como ciclo ${body.commissioning.cycle}; los datos existentes se conservaron.`);
      }
      form.reset();
      setDialog(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No fue posible actualizar la puesta en marcha.");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <section className="panel commissioning-card loading" aria-live="polite"><span className="commissioning-mark">PEM</span><div><span className="eyebrow">Puesta en marcha</span><h2>Consultando estado…</h2></div></section>;
  if (!commissioning) return <section className="panel commissioning-card"><div className="fuel-reset-heading"><span className="commissioning-mark warning">!</span><div><span className="eyebrow">Puesta en marcha</span><h2>Estado no disponible</h2></div></div><p>{error}</p><button className="secondary-button compact" type="button" onClick={() => { setLoading(true); setError(""); void load().catch((caught) => setError(caught instanceof Error ? caught.message : "No fue posible consultar la puesta en marcha.")).finally(() => setLoading(false)); }}>Reintentar</button></section>;

  const completed = commissioning.status === "completed";
  return <>
    <section className={`panel commissioning-card ${completed ? "completed" : "in-progress"}`}>
      <div className="commissioning-heading"><span className="commissioning-mark">{completed ? "✓" : "PEM"}</span><div><span className="eyebrow">Puesta en marcha · Ciclo {commissioning.cycle}</span><h2>{completed ? "Finalizada" : "En curso"}</h2></div><span className={`commissioning-state ${completed ? "completed" : ""}`}><i />{completed ? "Operación protegida" : "Herramientas habilitadas"}</span></div>
      <p>{completed ? "El registro productivo está protegido. El reinicio de carga y nivel ya no está disponible." : "Usa el reinicio sólo para establecer una base limpia antes de la recepción final. Cuando la PEM sea aprobada, ciérrala para proteger el histórico."}</p>
      <dl className="commissioning-meta"><div><dt>Unidad</dt><dd>{commissioning.siteId}</dd></div><div><dt>{completed ? "Finalizada" : "Ciclo iniciado"}</dt><dd>{formatAlertDate(completed && commissioning.completedAt ? commissioning.completedAt : commissioning.startedAt)}</dd></div></dl>
      {notice && <div className="commissioning-notice" role="status"><span>✓</span>{notice}</div>}
      {!completed && <div className="commissioning-actions"><button className="danger-button" type="button" onClick={() => { setError(""); setDialog("reset"); }}>Reiniciar base de datos</button><button className="primary-button" type="button" onClick={() => { setError(""); setDialog("complete"); }}>Finalizar PEM</button></div>}
      {completed && <button className="secondary-button compact" type="button" onClick={() => { setError(""); setDialog("reopen"); }}>Reabrir por rechazo</button>}
    </section>
    {dialog && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !submitting && setDialog(null)}>
      <section className="modal fuel-reset-modal" role="dialog" aria-modal="true" aria-labelledby="fuel-reset-title">
        <button className="modal-close" type="button" disabled={submitting} onClick={() => setDialog(null)} aria-label="Cerrar">×</button>
        <form onSubmit={submit}>
          <span className={dialog === "reset" ? "danger-mark" : "commissioning-modal-mark"}>{dialog === "complete" ? "✓" : "!"}</span>
          <div className="modal-intro"><span className="eyebrow">Acción exclusiva de administrador</span><h2 id="fuel-reset-title">{dialog === "reset" ? "Reiniciar carga y nivel" : dialog === "complete" ? "Finalizar puesta en marcha" : "Reabrir puesta en marcha"}</h2><p>{dialog === "reset" ? "Esta acción elimina definitivamente todas las cargas y lecturas anteriores. La siguiente lectura OCIO establecerá el nivel inicial del registro en terreno." : dialog === "complete" ? "El ciclo quedará cerrado y la herramienta de reinicio desaparecerá de esta unidad." : "Úsalo sólo si la recepción rechazó la PEM. Se abrirá un nuevo ciclo, pero no se borrará ningún dato automáticamente."}</p></div>
          {dialog === "reset" && <div className="form-note warning"><span>!</span>Los operadores, equipos, asociaciones y credenciales no serán eliminados.</div>}
          {dialog === "complete" && <div className="form-note success"><span>✓</span>El histórico productivo quedará protegido también en la API. Podrás reabrir la PEM si posteriormente es rechazada.</div>}
          {dialog === "reopen" && <label className="fuel-reset-password">Motivo del rechazo<textarea name="reason" required minLength={10} maxLength={500} rows={4} placeholder="Ej. Recepción rechazó la calibración de nivel y solicitó repetir las pruebas." /></label>}
          <label className="fuel-reset-password">Clave de administrador<input ref={passwordInput} name="administratorPassword" type="password" autoComplete="current-password" required maxLength={256} /></label>
          {error && <div className="auth-error" role="alert"><span>!</span>{error}</div>}
          <div className="modal-actions"><button className="secondary-button" type="button" disabled={submitting} onClick={() => setDialog(null)}>Cancelar</button><button className={dialog === "reset" ? "danger-button" : "primary-button"} type="submit" disabled={submitting}>{submitting ? "Verificando…" : dialog === "reset" ? "Reiniciar y comenzar registro" : dialog === "complete" ? "Confirmar PEM finalizada" : "Confirmar reapertura"}</button></div>
        </form>
      </section>
    </div>}
  </>;
}

function RelayTestPanel({ edge, online, onRefresh }: { edge: FuelHistoryResponse["edge"]; online: boolean; onRefresh: () => Promise<void> }) {
  const [command, setCommand] = useState<RelayTestCommand | null>(null);
  const [open, setOpen] = useState(false);
  const [durationSeconds, setDurationSeconds] = useState(10);
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState("");
  const [clock, setClock] = useState(0);
  const passwordInput = useRef<HTMLInputElement>(null);
  const active = command?.status === "pending" || command?.status === "running";
  const operationallyReady = Boolean(online && edge?.state === "locked" && !edge.relayEnergized && edge.k24Enabled && edge.k24Healthy);
  const startedAtMilliseconds = command?.startedAt ? new Date(command.startedAt).getTime() : Number.NaN;
  const elapsedSeconds = Number.isFinite(startedAtMilliseconds)
    ? Math.max(0, Math.floor((clock - startedAtMilliseconds) / 1000))
    : 0;
  const remaining = command?.status === "running"
    ? Math.max(0, Math.min(command.durationSeconds, command.durationSeconds - elapsedSeconds))
    : command?.durationSeconds ?? durationSeconds;

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => passwordInput.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

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

  const start = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const password = String(new FormData(form).get("administratorPassword"));
    setRequesting(true); setError("");
    try {
      const response = await fetch("/api/relay-test", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, durationSeconds }),
      });
      const body = await response.json() as { command?: RelayTestCommand; error?: string };
      if (!response.ok || !body.command) throw new Error(body.error ?? "No fue posible iniciar la prueba de bomba.");
      setCommand(body.command); setClock(Date.now());
      form.reset(); setOpen(false);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "No fue posible iniciar la prueba de bomba."); }
    finally { setRequesting(false); }
  };

  const statusCopy = command?.status === "completed" ? "Transacción completada; la bomba volvió a quedar bloqueada"
    : command?.status === "failed" ? command.error ?? "La transacción de prueba fue interrumpida"
      : command?.status === "expired" ? command.error ?? "La solicitud venció"
        : command?.status === "running" ? `Bomba habilitada · ${remaining} s restantes`
          : command?.status === "pending" ? "Esperando al PLC…" : "Disponible con el punto bloqueado";
  const completedSeconds = command ? Math.max(0, command.durationSeconds - remaining) : 0;
  return <>
    <section className={`panel relay-test-card ${command?.status ?? "idle"}`}><div className="relay-test-heading"><span className="relay-test-mark">P</span><div><span className="eyebrow">Mantenimiento local</span><h2>Prueba de bomba</h2></div></div><p>Actúa R0.1 directamente desde el PLC, sin usar el validador. Cada ejecución queda registrada como una transacción de prueba.</p>{command?.status === "running" && <div className="relay-test-progress" role="progressbar" aria-label="Tiempo restante de la prueba" aria-valuemin={0} aria-valuemax={command.durationSeconds} aria-valuenow={completedSeconds}><span style={{ width: `${completedSeconds / command.durationSeconds * 100}%` }} /></div>}<strong className="relay-test-status" role="status">{statusCopy}</strong>{error && !open && <small className="relay-test-error" role="alert">{error}</small>}<button className="primary-button compact" type="button" disabled={active || requesting} onClick={() => { setError(""); setOpen(true); }}>{active ? "Prueba en curso" : "Probar bomba"}</button>{!online && <small>Podrás configurar la prueba; la confirmación exigirá que el PLC esté reportando.</small>}{online && edge?.state !== "locked" && !active && <small>La ejecución requiere el punto en estado LOCKED.</small>}{online && (!edge?.k24Enabled || !edge.k24Healthy) && !active && <small>K24 debe estar habilitado y saludable.</small>}</section>
    {open && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !requesting && setOpen(false)}><section className="modal pump-test-modal" role="dialog" aria-modal="true" aria-labelledby="pump-test-title"><button className="modal-close" type="button" disabled={requesting} onClick={() => setOpen(false)} aria-label="Cerrar">×</button><form onSubmit={start}><div className="modal-intro"><span className="eyebrow">Acción exclusiva de administrador</span><h2 id="pump-test-title">Probar la bomba</h2><p>El PLC energizará R0.1 durante el tiempo indicado. El validador no participa en esta operación.</p></div><div className="form-grid pump-test-form"><label>Tiempo de habilitación (segundos)<input name="durationSeconds" type="number" min={5} max={60} step={1} value={durationSeconds} onChange={(event) => setDurationSeconds(Number(event.target.value))} required /></label><label>Clave de administrador<input ref={passwordInput} name="administratorPassword" type="password" autoComplete="current-password" required maxLength={256} /></label></div><div className="form-note warning"><span>!</span>Confirma que la zona esté despejada. K24 o una falla de control abrirán el relé antes del tiempo solicitado.</div><div className="form-note success"><span>✓</span>Se registrarán administrador, duración, inicio y resultado como transacción de prueba de bomba.</div>{!operationallyReady && <div className="auth-error" role="alert"><span>!</span>El PLC debe estar en línea, en LOCKED, con R0.1 abierto y K24 saludable.</div>}{error && <div className="auth-error" role="alert"><span>!</span>{error}</div>}<div className="modal-actions"><button className="secondary-button" type="button" disabled={requesting} onClick={() => setOpen(false)}>Cancelar</button><button className="primary-button" type="submit" disabled={requesting || !operationallyReady || durationSeconds < 5 || durationSeconds > 60}>{requesting ? "Verificando y habilitando…" : "Confirmar prueba de bomba"}</button></div></form></section></div>}
  </>;
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
  return <section className="panel bluetooth-calibration"><div className="calibration-heading"><span className="bluetooth-mark">B</span><div><span className="eyebrow">Zona de carga</span><h2>Calibración de proximidad Bluetooth</h2><p>Define la intensidad mínima que debe recibir el validador desde el MIM. Un valor menos negativo exige mayor cercanía.</p></div><span className={`apply-state ${applied ? "applied" : "pending"}`}><i />{applied ? "Aplicado en el validador" : "Esperando confirmación"}</span></div><div className="calibration-control"><div className="threshold-value"><strong>{threshold}</strong><span>dBm</span><small>{threshold >= -55 ? "Zona muy cercana" : threshold >= -70 ? "Zona cercana" : threshold >= -85 ? "Zona amplia" : "Zona muy amplia"}</small></div><label><span>Más alcance</span><input type="range" min="-100" max="-35" step="1" value={threshold} onChange={(event) => { setThreshold(Number(event.target.value)); setDirty(true); dirtyRef.current = true; }} /><span>Más cercanía</span></label><button className="primary-button compact" type="button" disabled={saving || threshold === settings?.rssiThreshold} onClick={() => save()}>{saving ? "Guardando…" : "Aplicar umbral"}</button></div><div className="calibration-evidence"><span className="signal-sample">{settings?.lastObservedRssi ?? "—"} <small>dBm medidos</small></span><div><strong>{relation}</strong><small>{settings?.lastObservedModule ? `MIM ${settings.lastObservedModule} · ${settings.observedAt ? formatAlertDate(settings.observedAt) : "sin fecha"}` : "La medición se registra en el validador, no en el Bluetooth del PLC."}</small></div></div>{error && <div className="auth-error" role="alert"><span>!</span>{error}</div>}<small className="calibration-note">Calibra con el tractor detenido en el borde real de la zona. Guarda un umbral 3–6 dB mayor que la lectura del borde para evitar autorizaciones fuera del área.</small></section>;
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="empty-state"><span>⌕</span><strong>{title}</strong><p>{detail}</p></div>;
}

function ModalLayer({ modal, alerts, transactions, operators, rfidCredentials, equipment, candidates, userName, canManageAlerts, isProviderAdmin, onClose, onAddOperator, onAddEquipment, onAddAssociation, onShowEquipment, onEditEquipment, onEditEquipmentValidity, onToggleEquipment, onArchiveEquipment, onDeleteEquipment, onRevalidateEquipment, onRenameEquipment, onModifyEquipmentValidity, onEnrollEquipment, onNfcEnrolled, onAssignRfid, onDeleteRfid, onPermanentDelete, onUpdateAlert, onReopenAlert, onOpenAlert }: { modal: NonNullable<Modal>; alerts: AlertItem[]; transactions: Transaction[]; operators: Operator[]; rfidCredentials: RfidCredential[]; equipment: Equipment[]; candidates: EnrollmentCandidate[]; userName: string; canManageAlerts: boolean; isProviderAdmin: boolean; onClose: () => void; onAddOperator: (item: Operator) => Promise<void>; onAddEquipment: (item: Equipment) => void; onAddAssociation: (item: Association) => void; onShowEquipment: (id: string) => void; onEditEquipment: (id: string) => void; onEditEquipmentValidity: (id: string) => void; onToggleEquipment: (item: Equipment) => void; onArchiveEquipment: (item: Equipment, archived: boolean) => void; onDeleteEquipment: (item: Equipment) => void; onRevalidateEquipment: (moduleId: string) => void; onRenameEquipment: (id: string, name: string) => Promise<void>; onModifyEquipmentValidity: (id: string, expiry: string) => Promise<void>; onEnrollEquipment: (moduleId: string, assignment: EnrollmentAssignment) => Promise<void>; onNfcEnrolled: () => Promise<void>; onAssignRfid: (credentialId: string, operatorId: string | null) => Promise<void>; onDeleteRfid: (credentialId: string) => Promise<void>; onPermanentDelete: (type: ManagedEntityType, id: string) => void; onUpdateAlert: (alertId: string, update: { description: string; status: AlertStatus; priority: AlertPriority; powerIncidentType?: PowerIncidentType | null }) => Promise<void>; onReopenAlert: (alertId: string, update: { reason: string; priority: AlertPriority }) => Promise<void>; onOpenAlert: (alertId: string) => void }) {
  const modalPanelRef = useRef<HTMLElement | null>(null);
  const modalContentKey = modal.type === "alertDetail" ? `${modal.type}:${modal.alertId}` : modal.type;
  useEffect(() => {
    const close = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  useEffect(() => {
    modalPanelRef.current?.scrollTo({ top: 0 });
  }, [modalContentKey]);
  const transaction = modal.type === "transaction" ? transactions.find((item) => item.id === modal.id) : null;
  const selectedEquipment = modal.type === "equipmentDetail" ? equipment.find((item) => item.id === modal.id) : null;
  const selectedEquipmentCandidate = selectedEquipment ? candidates.find((item) => item.moduleId === selectedEquipment.module && ["detected", "failed"].includes(item.status)) : null;
  const renamedEquipment = modal.type === "equipmentRename" ? equipment.find((item) => item.id === modal.id) : null;
  const validityEquipment = modal.type === "equipmentValidity" ? equipment.find((item) => item.id === modal.id) : null;
  const selectedAlert = modal.type === "alertDetail" ? alerts.find((item) => item.id === modal.alertId) : null;
  const enrollmentCandidate = modal.type === "equipmentEnrollment" ? candidates.find((item) => item.moduleId === modal.moduleId) : null;
  const enrolledEquipment = enrollmentCandidate ? equipment.find((item) => item.module === enrollmentCandidate.moduleId && !item.archivedAt) : null;
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section ref={modalPanelRef} className={`modal ${modal.type === "alertDetail" ? "alert-detail-modal" : ""}`} role="dialog" aria-modal="true" aria-labelledby="modal-title">
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
    {modal.type === "equipmentDetail" && (selectedEquipment ? <EquipmentDetail item={selectedEquipment} candidate={selectedEquipmentCandidate ?? undefined} isProviderAdmin={isProviderAdmin} onRename={() => onEditEquipment(selectedEquipment.id)} onModifyValidity={() => onEditEquipmentValidity(selectedEquipment.id)} onToggle={() => onToggleEquipment(selectedEquipment)} onArchive={(archived) => onArchiveEquipment(selectedEquipment, archived)} onDelete={() => onDeleteEquipment(selectedEquipment)} onRevalidate={() => selectedEquipmentCandidate && onRevalidateEquipment(selectedEquipmentCandidate.moduleId)} /> : <EmptyState title="Equipo no disponible" detail="El registro fue actualizado o archivado." />)}
    {modal.type === "equipmentRename" && (renamedEquipment ? <EquipmentRenameForm item={renamedEquipment} onSubmit={onRenameEquipment} onCancel={() => onShowEquipment(renamedEquipment.id)} /> : <EmptyState title="Equipo no disponible" detail="Actualiza la lista e inténtalo nuevamente." />)}
    {modal.type === "equipmentValidity" && (validityEquipment ? <EquipmentValidityForm item={validityEquipment} onSubmit={onModifyEquipmentValidity} onCancel={() => onShowEquipment(validityEquipment.id)} /> : <EmptyState title="Equipo no disponible" detail="Actualiza la lista e inténtalo nuevamente." />)}
    {modal.type === "equipmentEnrollment" && (enrollmentCandidate ? <EquipmentEnrollmentForm candidate={enrollmentCandidate} equipment={enrolledEquipment ?? undefined} onSubmit={(assignment) => onEnrollEquipment(enrollmentCandidate.moduleId, assignment)} onCancel={onClose} /> : <EmptyState title="Módulo fuera de alcance" detail="Energízalo nuevamente para continuar." />)}
    {modal.type === "alertDetail" && (selectedAlert ? <AlertDetail key={selectedAlert.id} alert={selectedAlert} previousAlert={selectedAlert.parentAlertId ? alerts.find((item) => item.id === selectedAlert.parentAlertId) : undefined} reopenedAlert={selectedAlert.reopenedAsAlertId ? alerts.find((item) => item.id === selectedAlert.reopenedAsAlertId) : undefined} userName={userName} canManage={canManageAlerts} onSubmit={(update) => onUpdateAlert(modal.alertId, update)} onReopen={(update) => onReopenAlert(modal.alertId, update)} onOpenRelated={onOpenAlert} /> : <EmptyState title="Alerta no disponible" detail="La alerta ya fue actualizada." />)}
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
  return <form onSubmit={submit}><ModalIntro eyebrow="MIM DETECTADO Y VERIFICADO" title={revalidating ? "Asignar MIM a este fundo" : "Crear asignación temporal"} detail="La identidad del Módulo Identificador de Máquina se conserva. Aquí defines el equipo y hasta cuándo puede operar en el fundo actual." /><div className="enrollment-device-summary"><span className="bluetooth-mark">W</span><div><strong>{candidate.moduleId}</strong><small>{candidate.siteId} · enlace Wi-Fi {candidate.rssi} dBm</small></div></div><div className="form-grid"><label className="full">Nombre visible<input name="name" required minLength={3} maxLength={80} defaultValue={equipment?.name ?? candidate.requestedName ?? candidate.deviceName ?? ""} placeholder="Ej. Tractor John Deere 6155M" /></label><label>Tipo<select name="kind" required defaultValue={equipment?.kind ?? candidate.requestedKind ?? "Tractor"}><option>Tractor</option><option>Trilladora</option><option>Camión</option><option>Camioneta</option><option>Otro</option></select></label><label>Vence en este fundo<input name="validUntil" type="datetime-local" required min={localDateTimeFromNow(0, 15)} defaultValue={localDateTimeFromNow(7)} /></label></div>{error && <div className="auth-error" role="alert"><span>!</span>{error}</div>}<div className="form-note success"><span>✓</span>Al vencer, la carga queda bloqueada. Para renovar o reasignar, mantén presionado 20 segundos el botón del MIM durante el arranque.</div><div className="modal-actions"><button type="button" className="secondary-button" onClick={onCancel}>Cancelar</button><button className="primary-button" disabled={submitting}>{submitting ? "Validando…" : revalidating ? "Asignar y revalidar" : "Nombrar y enrolar"}</button></div></form>;
}

function ModalIntro({ eyebrow, title, detail }: { eyebrow: string; title: string; detail?: string }) {
  return <div className="modal-intro"><span className="eyebrow">{eyebrow}</span><h2 id="modal-title">{title}</h2>{detail && <p>{detail}</p>}</div>;
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
  return <form onSubmit={submit}><ModalIntro eyebrow="Nuevo registro" title="Crear operador" detail="Después de guardar podrás iniciar el enrolamiento de su credencial RFID." /><div className="form-grid"><label className="full">Nombre completo<input name="name" required minLength={3} placeholder="Ej. Juan Pérez" /></label><label>RUT<input name="rut" required autoComplete="off" placeholder="12.345.678-5" aria-describedby={error ? "operator-rut-error" : undefined} /></label><label>Tipo de operador<select name="type" defaultValue="Maquinaria"><option>Maquinaria</option><option>Encargado</option><option>Contratista</option></select></label><label className="full">Nota opcional<textarea name="note" rows={3} placeholder="Información útil para la administración local" /></label></div>{error && <div id="operator-rut-error" className="auth-error modal-form-error" role="alert"><span>!</span>{error}</div>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={onCancel}>Cancelar</button><button className="primary-button" type="submit" disabled={submitting}>{submitting ? "Creando…" : "Crear operador"}</button></div></form>;
}

function EquipmentForm({ onSubmit, onCancel }: { onSubmit: (item: Equipment) => void; onCancel: () => void }) {
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const data = new FormData(event.currentTarget); const condition = String(data.get("condition")) as Equipment["condition"]; const expiryValue = String(data.get("expiry")); onSubmit({ id: `eq-${Date.now()}`, name: String(data.get("name")), kind: String(data.get("kind")) as EquipmentKind, condition, module: String(data.get("module")) || "Sin módulo", siteId: "", active: true, expiry: condition === "Permanente" || !expiryValue ? undefined : new Date(expiryValue).toISOString() }); };
  return <form onSubmit={submit}><ModalIntro eyebrow="Inventario" title="Crear equipo abastecible" detail="El equipo quedará disponible para asociarlo con operadores activos." /><div className="form-grid"><label className="full">Nombre del equipo<input name="name" required placeholder="Ej. Tractor John Deere 6155M" /></label><label>Tipo<select name="kind" required defaultValue="Tractor"><option>Tractor</option><option>Trilladora</option><option>Camión</option><option>Camioneta</option><option>Otro</option></select></label><label>Condición<select name="condition" defaultValue="Permanente"><option>Permanente</option><option>Temporal</option><option>Externo</option></select></label><label>Módulo ESP32<input name="module" placeholder="KT-MOD-0000" /></label><label>Vigencia temporal<input name="expiry" type="datetime-local" min={localDateTimeFromNow(0, 15)} /></label></div><div className="form-note"><span>i</span>Los módulos temporales se validan físicamente por Bluetooth antes de renovar su vigencia en un fundo.</div><div className="modal-actions"><button type="button" className="secondary-button" onClick={onCancel}>Cancelar</button><button className="primary-button" type="submit">Crear equipo</button></div></form>;
}

function EquipmentRenameForm({ item, onSubmit, onCancel }: { item: Equipment; onSubmit: (id: string, name: string) => Promise<void>; onCancel: () => void }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name")).trim();
    if (name.length < 3 || name.length > 80) {
      setError("El nombre debe tener entre 3 y 80 caracteres.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      await onSubmit(item.id, name);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No fue posible modificar el nombre.");
      setSubmitting(false);
    }
  };
  return <form onSubmit={submit}><ModalIntro eyebrow="Identificación del equipo" title="Modificar nombre" detail="Este nombre se mostrará en equipos, asociaciones, cargas y reportes nuevos." /><div className="enrollment-device-summary"><span className="equipment-icon small">{item.kind.slice(0, 2).toUpperCase()}</span><div><strong>{item.module}</strong><small>{item.siteId || "Sin fundo asignado"}</small></div></div><div className="form-grid"><label className="full">Nombre visible<input name="name" required minLength={3} maxLength={80} defaultValue={item.name} /></label></div>{error && <div className="auth-error modal-form-error" role="alert"><span>!</span>{error}</div>}<div className="form-note"><span>i</span>La identidad criptográfica y la asignación del MIM no cambian.</div><div className="modal-actions"><button type="button" className="secondary-button" onClick={onCancel} disabled={submitting}>Cancelar</button><button className="primary-button" type="submit" disabled={submitting}>{submitting ? "Guardando…" : "Guardar nombre"}</button></div></form>;
}

function EquipmentValidityForm({ item, onSubmit, onCancel }: { item: Equipment; onSubmit: (id: string, expiry: string) => Promise<void>; onCancel: () => void }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = String(new FormData(event.currentTarget).get("expiry"));
    const instant = new Date(value);
    if (!value || !Number.isFinite(instant.getTime()) || instant.getTime() <= Date.now()) {
      setError("Selecciona una fecha y hora futuras.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      await onSubmit(item.id, instant.toISOString());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No fue posible modificar el período de validez.");
      setSubmitting(false);
    }
  };
  const defaultExpiry = item.expiry && !item.assignmentExpired
    ? localDateTimeFromInstant(item.expiry)
    : localDateTimeFromNow(7);
  return <form onSubmit={submit}><ModalIntro eyebrow="Asignación del MIM" title="Modificar período de validez" detail="Extiende o acorta manualmente el tiempo durante el que este MIM puede autorizar nuevas cargas." /><div className="enrollment-device-summary"><span className="equipment-icon small">{item.kind.slice(0, 2).toUpperCase()}</span><div><strong>{item.module}</strong><small>{item.name} · {item.siteId || "Sin fundo asignado"}</small></div></div><div className="form-grid"><label className="full">Nueva fecha y hora de vencimiento<input name="expiry" type="datetime-local" required min={localDateTimeFromNow(0, 1)} max={localDateTimeFromNow(366)} defaultValue={defaultExpiry} /></label></div>{item.expiry && <div className="validity-current"><span>Vigencia actual</span><strong>{formatAssignmentDate(item.expiry)}</strong></div>}{error && <div className="auth-error modal-form-error" role="alert"><span>!</span>{error}</div>}<div className="form-note warning"><span>!</span>El cambio entra en vigencia inmediatamente. Al llegar la nueva fecha, se bloquearán las cargas nuevas; una carga ya iniciada no se interrumpe.</div><div className="modal-actions"><button type="button" className="secondary-button" onClick={onCancel} disabled={submitting}>Cancelar</button><button className="primary-button" type="submit" disabled={submitting}>{submitting ? "Guardando…" : "Guardar período"}</button></div></form>;
}

function AssociationForm({ operators, equipment, onSubmit, onCancel }: { operators: Operator[]; equipment: Equipment[]; onSubmit: (item: Association) => void; onCancel: () => void }) {
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const data = new FormData(event.currentTarget); onSubmit({ id: `as-${Date.now()}`, operatorId: String(data.get("operator")), equipmentId: String(data.get("equipment")), active: true, since: "10 ago 2026" }); };
  return <form onSubmit={submit}><ModalIntro eyebrow="Autorización local" title="Nueva asociación" detail="Vincula un operador habilitado con un equipo disponible." /><div className="association-form"><label>Operador<select name="operator" required>{operators.filter((item) => item.active).map((item) => <option value={item.id} key={item.id}>{item.name} · {item.credential}</option>)}</select></label><div className="association-form-link">↕</div><label>Equipo<select name="equipment" required>{equipment.filter((item) => item.active).map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label></div><div className="form-note success"><span>✓</span>La asociación entrará en vigencia inmediatamente y quedará registrada en la auditoría local.</div><div className="modal-actions"><button type="button" className="secondary-button" onClick={onCancel}>Cancelar</button><button className="primary-button" type="submit">Crear asociación</button></div></form>;
}

function AlertDetail({ alert, previousAlert, reopenedAlert, userName, canManage, onSubmit, onReopen, onOpenRelated }: { alert: AlertItem; previousAlert?: AlertItem; reopenedAlert?: AlertItem; userName: string; canManage: boolean; onSubmit: (update: { description: string; status: AlertStatus; priority: AlertPriority; powerIncidentType?: PowerIncidentType | null }) => Promise<void>; onReopen: (update: { reason: string; priority: AlertPriority }) => Promise<void>; onOpenRelated: (alertId: string) => void }) {
  const electrical = isPowerAlert(alert);
  const [powerIncidentType, setPowerIncidentType] = useState<PowerIncidentType | "">(alert.powerIncidentType ?? "");
  const [status, setStatus] = useState<AlertStatus>(alert.status);
  const [priority, setPriority] = useState<AlertPriority>(alert.priority);
  const [reopenPriority, setReopenPriority] = useState<AlertPriority>(alert.priority);
  const [showReopenForm, setShowReopenForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const description = String(data.get("comment")).trim();
    if (description.length < 10) return;
    setSubmitting(true); setError("");
    try {
      await onSubmit({ description, status, priority, ...(electrical ? { powerIncidentType: powerIncidentType || null } : {}) });
      form.reset();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No fue posible guardar el seguimiento.");
    } finally {
      setSubmitting(false);
    }
  };
  const submitReopening = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const reason = String(new FormData(event.currentTarget).get("reason")).trim();
    if (reason.length < 10) return;
    setReopening(true); setError("");
    try { await onReopen({ reason, priority: reopenPriority }); }
    catch (caught) {
      setError(caught instanceof Error ? caught.message : "No fue posible reabrir la alerta.");
      setReopening(false);
    }
  };
  return <div className="alert-detail">
    <ModalIntro eyebrow={alert.reopenNumber > 0 ? `Alerta reabierta · ciclo ${alert.reopenNumber}` : "Seguimiento de alerta"} title={alert.title} />
    <div className="alert-detail-summary"><span className={`alert-priority-mark ${alert.priority}`} aria-hidden="true">{alert.priority === "urgent" ? "!" : alert.priority === "high" ? "↑" : alert.priority === "medium" ? "•" : "↓"}</span><div><div>{alert.reopenNumber > 0 && <span className="alert-reopened-badge">Reabierta · ciclo {alert.reopenNumber}</span>}<span className={`priority-badge ${alert.priority}`}>{alertPriorityCopy[alert.priority]}</span><span className={`alert-status-badge ${alert.status}`}>{alertStatusCopy[alert.status]}</span></div><p>{alert.detail}</p>{electrical && <span className="power-alert-classification">{alert.powerIncidentType ? powerIncidentLabels[alert.powerIncidentType] : "Pendiente de clasificación eléctrica"}</span>}<time>Inicio de este ciclo: {formatAlertDate(alert.time)}</time></div></div>
    {(alert.parentAlertId || alert.reopenedAsAlertId) && <section className="alert-cycle-links" aria-label="Relación entre ciclos de la alerta">
      {alert.parentAlertId && <div><span>←</span><p><strong>Ciclo anterior cerrado</strong></p><button type="button" className="secondary-button small" onClick={() => onOpenRelated(alert.parentAlertId!)}>Ver anterior{previousAlert ? ` · ${alertStatusCopy[previousAlert.status]}` : ""}</button></div>}
      {alert.reopenedAsAlertId && <div><span>→</span><p><strong>Reabierta en un ciclo posterior</strong></p><button type="button" className="secondary-button small" onClick={() => onOpenRelated(alert.reopenedAsAlertId!)}>Ver reapertura{reopenedAlert ? ` · ciclo ${reopenedAlert.reopenNumber}` : ""}</button></div>}
    </section>}
    <section className="alert-comment-history"><div className="alert-history-heading"><h3>Historial de comentarios</h3><span>{alert.comments?.length ?? 0} {(alert.comments?.length ?? 0) === 1 ? "registro" : "registros"}</span></div>{canManage ? (alert.comments?.length ? <ol>{alert.comments.map((entry) => <li key={entry.id}><span className={`comment-dot ${entry.statusAfter}`} /><div><div><strong>{entry.actor}</strong><time>{formatAlertDate(entry.recordedAt)}</time></div><p>{entry.comment}</p><small>{entry.eventType === "reopened" ? "Motivo de reapertura" : alertStatusCopy[entry.statusAfter]} · Prioridad {alertPriorityCopy[entry.priorityAfter]}{entry.powerIncidentTypeAfter ? ` · ${powerIncidentLabels[entry.powerIncidentTypeAfter]}` : ""}</small></div></li>)}</ol> : <div className="alert-history-empty">Aún no hay comentarios. Registra la primera revisión debajo.</div>) : <div className="alert-history-empty protected">El historial está disponible para el administrador principal y los encargados autorizados.</div>}</section>
    {canManage && alert.status !== "resolved" && <form className="alert-follow-up-form" onSubmit={submit}><div className="form-grid"><label>Estado al guardar<select name="status" value={status} onChange={(event) => setStatus(event.target.value as AlertStatus)}><option value="pending">Pendiente</option><option value="in_progress">Tomando acción</option><option value="resolved">Resuelta</option></select></label><label>Criticidad<select name="priority" value={priority} onChange={(event) => setPriority(event.target.value as AlertPriority)}><option value="urgent">Urgente</option><option value="high">Alta</option><option value="medium">Media</option><option value="low">Baja</option></select></label>{electrical && <label className="full">Tipo de falla eléctrica<select name="powerIncidentType" value={powerIncidentType} required={status === "resolved"} onChange={event => setPowerIncidentType(event.target.value as PowerIncidentType | "")}><option value="">Pendiente de clasificación</option>{Object.entries(powerIncidentLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><small>Selecciona la causa confirmada antes de resolver. La clasificación queda en el historial.</small></label>}<label className="full">Comentario de seguimiento<textarea name="comment" required minLength={10} maxLength={500} rows={4} placeholder="Describe qué se revisó, qué acción está en curso o cómo se resolvió…" /></label><label className="full">Responsable<input value={userName} readOnly /></label></div>{status === "resolved" ? <div className="form-note warning"><span>!</span>Al guardar como resuelta, la alerta se cerrará definitivamente.</div> : <div className="form-note"><span>i</span>La alerta seguirá abierta y podrás agregar nuevos comentarios más adelante.</div>}{error && <div className="auth-error" role="alert"><span>!</span>{error}</div>}<div className="modal-actions"><button className="primary-button" type="submit" disabled={submitting}>{submitting ? "Guardando…" : status === "resolved" ? "Guardar comentario y resolver" : "Guardar seguimiento"}</button></div></form>}
    {canManage && alert.status === "resolved" && <><div className="alert-resolved-note"><span>✓</span><div><strong>Alerta resuelta</strong></div></div>
      {!alert.reopenedAsAlertId && !showReopenForm && <div className="alert-reopen-action"><p>Si la condición volvió a presentarse, inicia un ciclo independiente sin modificar este cierre.</p><button type="button" className="secondary-button" onClick={() => { setShowReopenForm(true); setError(""); }}>Reabrir como nueva alerta</button></div>}
      {alert.reopenedAsAlertId && <div className="form-note"><span>i</span>Esta alerta ya fue reabierta. Continúa el seguimiento desde el ciclo enlazado.</div>}
      {!alert.reopenedAsAlertId && showReopenForm && <form className="alert-reopen-form" onSubmit={submitReopening}><div className="form-grid"><label>Criticidad del nuevo ciclo<select name="reopenPriority" value={reopenPriority} onChange={(event) => setReopenPriority(event.target.value as AlertPriority)}><option value="urgent">Urgente</option><option value="high">Alta</option><option value="medium">Media</option><option value="low">Baja</option></select></label><label className="full">Motivo de reapertura<textarea name="reason" required minLength={10} maxLength={500} rows={4} placeholder="Describe qué volvió a ocurrir o qué evidencia nueva requiere atención…" /></label><label className="full">Responsable de la reapertura<input value={userName} readOnly /></label></div><div className="form-note warning"><span>!</span>Se creará una alerta nueva en estado Pendiente. Este cierre y sus métricas no cambiarán.</div>{error && <div className="auth-error" role="alert"><span>!</span>{error}</div>}<div className="modal-actions"><button type="button" className="secondary-button" disabled={reopening} onClick={() => { setShowReopenForm(false); setError(""); }}>Cancelar</button><button className="primary-button" type="submit" disabled={reopening}>{reopening ? "Creando nuevo ciclo…" : "Confirmar reapertura"}</button></div></form>}
    </>}
  </div>;
}

function PermanentDeleteConfirm({ name, type, onConfirm, onCancel }: { name: string; type: ManagedEntityType; onConfirm: () => void; onCancel: () => void }) {
  const labels: Record<ManagedEntityType, string> = { operators: "operador", equipment: "equipo", associations: "asociación" };
  return <div className="delete-confirm"><span className="danger-mark">!</span><ModalIntro eyebrow="Administración del proveedor" title="Eliminar definitivamente" detail={`Esta acción borrará el ${labels[type]} de la base local y no se puede deshacer.`} /><div className="delete-target"><small>REGISTRO SELECCIONADO</small><strong>{name}</strong></div><p>{type === "equipment" ? "Se eliminará la asignación operacional. La identidad segura del MIM se conservará para que el módulo pueda volver a enrolarse después de un reset físico de 20 segundos." : "La eliminación sólo está permitida para registros archivados. Los registros con asociaciones históricas se protegen hasta que esas relaciones sean eliminadas primero."}</p><div className="modal-actions"><button type="button" className="secondary-button" onClick={onCancel}>Cancelar</button><button type="button" className="danger-button" onClick={onConfirm}>Eliminar de la base de datos</button></div></div>;
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
      if (!response.ok || !body.command) throw new Error(body.error ?? "No fue posible abrir la ventana RFID.");
      setCommandId(body.command.id); setStatus("pending");
      setSeconds(Math.max(0, Math.floor((new Date(body.command.expiresAt).getTime() - Date.now()) / 1000)));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No fue posible abrir la ventana RFID."); setStatus("failed");
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
      } catch (caught) { setError(caught instanceof Error ? caught.message : "Se perdió la comunicación con el PLC."); }
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
  if (status === "approval" && currentMaster) return <div className="enroll-modal"><ModalIntro eyebrow="Aprobación requerida" title="Reemplazar tarjeta maestra" detail="Por diseño sólo puede existir una tarjeta maestra activa en el sistema." /><div className="master-replacement-warning" role="alert"><span>!</span><div><strong>La tarjeta anterior se desactivará</strong><p>{currentMaster.operatorName} · {formatCredentialId(currentMaster.credentialId)}</p><small>Después de aprobar, esa tarjeta dejará de autorizar cargas. El cambio quedará registrado con tu usuario.</small></div></div><div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancelar</button><button type="button" className="danger-button" onClick={() => void openEnrollment(true, currentMaster.credentialId)}>Aprobar y enrolar la nueva</button></div></div>;
  return <div className="enroll-modal"><ModalIntro eyebrow={isMaster ? "Tarjeta maestra de emergencia" : "Enrolamiento RFID"} title={`Tag de ${operatorName}`} detail={status === "completed" ? `El tag quedó vinculado como ${isMaster ? "tarjeta maestra" : "credencial normal"} en el PLC.` : status === "reading" ? "La ventana de lectura está abierta en el validador del Fundo Santa Isabel." : "El PLC está preparando el validador del Fundo Santa Isabel."} /><div className="nfc-animation"><RfidTagSchematic completed={status === "completed"} /></div><h3>{status === "opening" ? "Abriendo el validador…" : status === "completed" ? "Tag enrolado correctamente" : status === "failed" ? "No se pudo completar" : status === "reading" ? "Validador listo; presenta el tag" : "Preparando el validador…"}</h3><p>{status === "completed" ? isMaster ? "Podrá autorizar cargas de emergencia sin un equipo válido; todas quedarán auditadas." : "Ya puedes usarlo en una autorización de carga normal." : status === "reading" ? "Acerca y mantén el tag. No lo retires hasta recibir confirmación." : "Espera a que aparezca “Validador listo” antes de acercar el tag."}</p>{error && <div className="auth-error" role="alert"><span>!</span>{error}</div>}{!["completed", "failed"].includes(status) && <div className="enroll-timer"><span>Ventana disponible</span><strong>{minute}:{second}</strong></div>}<div className="modal-actions centered"><button type="button" className={status === "completed" ? "primary-button" : "secondary-button"} onClick={cancel}>{status === "completed" ? "Listo" : "Cancelar enrolamiento"}</button></div></div>;
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
  return <form onSubmit={submit}><ModalIntro eyebrow="Vinculación RFID · Operador" title="Asignar credencial" detail="Cada credencial y cada operador pueden participar en una sola vinculación." /><div className="association-form"><label>Credencial<select name="credentialId" value={credentialId} onChange={(event) => chooseCredential(event.target.value)} required>{credentials.map((item) => <option value={item.credentialId} key={item.credentialId}>{formatCredentialId(item.credentialId)} · {item.credentialIsMaster ? "Maestra" : "Normal"}</option>)}</select></label><div className="association-form-link">↕</div><label>Operador<select name="operatorId" value={operatorId} onChange={(event) => setOperatorId(event.target.value)} required><option value="">Seleccionar operador</option>{eligibleOperators.map((item) => <option value={item.id} key={item.id}>{item.name} · {item.rut}</option>)}</select></label></div>{selected?.credentialIsMaster && <div className="form-note warning"><span>!</span>Esta vinculación entrega el privilegio de emergencia al operador seleccionado.</div>}{credentials.length === 0 && <div className="auth-error modal-form-error"><span>!</span>Primero enrola una credencial RFID.</div>}{error && <div className="auth-error modal-form-error" role="alert"><span>!</span>{error}</div>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={onCancel}>Cancelar</button><button className="primary-button" disabled={submitting || !credentialId || !operatorId}>{submitting ? "Guardando…" : "Guardar vinculación"}</button></div></form>;
}

function RfidDeleteConfirm({ credentialId, onConfirm, onCancel }: { credentialId: string; onConfirm: () => void; onCancel: () => void }) {
  return <div className="delete-confirm"><span className="danger-mark">!</span><ModalIntro eyebrow="Inventario RFID" title="Eliminar credencial" detail="La credencial se borrará de la base local y dejará de autorizar en el PLC." /><div className="delete-target"><small>TAG SELECCIONADO</small><strong>{formatCredentialId(credentialId)}</strong></div><p>El tag físico no se destruye. Si vuelves a enrolarlo, podrá incorporarse nuevamente al inventario.</p><div className="modal-actions"><button type="button" className="secondary-button" onClick={onCancel}>Cancelar</button><button type="button" className="danger-button" onClick={onConfirm}>Eliminar de la base de datos</button></div></div>;
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
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Se perdió la comunicación con el PLC.");
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
  return <div className="enroll-modal identify-credential-modal"><ModalIntro eyebrow="Consulta RFID" title="Identificar tag" detail="La consulta autentica el tag y busca a su operador sin modificar ni enrolar datos." />{status === "completed" ? <div className={`identification-result ${result?.registered ? "registered" : "unregistered"}`}>{result?.operator ? <><span className="large-avatar">{initials(result.operator.name)}</span><div><small>TAG REGISTRADO</small><h3>{result.operator.name}</h3><p>{result.operator.rut}</p><strong className={result.operator.active && result.operator.credentialActive && !result.operator.archivedAt ? "active-text" : "muted-text"}><i />{operatorState}</strong></div></> : result?.registered ? <><span className="rfid-mini">⌁</span><div><small>TAG ENROLADO</small><h3>Sin operador asociado</h3><p>Está en el inventario RFID y disponible para vincular.</p></div></> : <><span className="identification-unknown">?</span><div><small>RESULTADO DE LA CONSULTA</small><h3>Tag no registrado</h3><p>No forma parte del inventario RFID del sistema.</p></div></>}</div> : <><div className="nfc-animation"><RfidTagSchematic /></div><h3>{status === "opening" ? "Abriendo el validador…" : status === "failed" ? "No se pudo identificar" : status === "reading" ? "Validador listo; presenta el tag" : "Preparando el validador…"}</h3><p>{status === "reading" ? "Apoya el tag centrado y déjalo quieto hasta escuchar la confirmación; no necesitas volver a presentarlo." : "Espera a que el validador confirme que está listo."}</p></>}{error && <div className="auth-error" role="alert"><span>!</span>{error}</div>}{!["completed", "failed"].includes(status) && <div className="enroll-timer"><span>Ventana disponible</span><strong>{minute}:{second}</strong></div>}{result && <code className="identified-credential-id">{formatCredentialId(result.credentialId)}</code>}<div className="modal-actions centered"><button type="button" className={status === "completed" ? "primary-button" : "secondary-button"} onClick={close}>{status === "completed" ? "Listo" : "Cancelar identificación"}</button></div></div>;
}

function TransactionDetail({ item }: { item: Transaction }) {
  return <div><ModalIntro eyebrow="Detalle de carga" title={item.id} detail={`${formatSiteDate(item.occurredAt)} · Fundo Santa Isabel`} /><div className="transaction-amount"><span>Volumen registrado</span><strong>{formatVolume(item.liters)} <small>L</small></strong><StatusBadge status={item.status} /></div><dl className="detail-grid"><div><dt>Operador</dt><dd>{item.operator}</dd></div><div><dt>Equipo</dt><dd>{item.equipment}</dd></div><div><dt>Duración</dt><dd>{item.duration}</dd></div><div><dt>Validación</dt><dd>{item.validation}</dd></div>{item.manualModeSessionId && <div><dt>Sesión manual</dt><dd>{item.manualModeSessionId}</dd></div>}<div><dt>Origen de dato</dt><dd>{item.source}</dd></div><div><dt>Persistencia</dt><dd className="success">Registrada por el edge</dd></div></dl></div>;
}

function EquipmentDetail({ item, candidate, isProviderAdmin, onRename, onModifyValidity, onToggle, onArchive, onDelete, onRevalidate }: { item: Equipment; candidate?: EnrollmentCandidate; isProviderAdmin: boolean; onRename: () => void; onModifyValidity: () => void; onToggle: () => void; onArchive: (archived: boolean) => void; onDelete: () => void; onRevalidate: () => void }) {
  const expired = Boolean(item.assignmentExpired);
  const archived = Boolean(item.archivedAt);
  return <div><ModalIntro eyebrow="Ficha de equipo" title={item.name} /><div className="equipment-detail-head"><span className="equipment-icon">{item.kind.slice(0, 2).toUpperCase()}</span><div><span className={`condition ${expired && !archived ? "expired" : item.condition.toLowerCase()}`}>{archived ? "Histórico" : expired ? "Vencido" : item.condition}</span><strong>{archived ? "Registro archivado" : expired ? "Carga bloqueada hasta revalidar" : item.active ? "Disponible para carga" : "Fuera de servicio"}</strong></div></div><dl className="detail-grid"><div><dt>Tipo</dt><dd>{item.kind}</dd></div><div><dt>Estado</dt><dd className={!archived && !expired && item.active ? "success" : ""}>{archived ? "Histórico" : expired ? "Vencido" : item.active ? "Habilitado" : "Desactivado"}</dd></div><div><dt>Módulo</dt><dd>{item.module}</dd></div><div><dt>Vigencia en el fundo</dt><dd>{item.expiry ? formatAssignmentDate(item.expiry) : "Sin vencimiento"}</dd></div><div><dt>Fundo asignado</dt><dd>{item.siteId || "Sin asignación"}</dd></div></dl><section className="equipment-detail-actions" aria-label="Acciones del equipo"><div><span className="eyebrow">Administración</span><h3>{archived ? "Opciones del registro histórico" : "Acciones del equipo"}</h3></div><div className="equipment-detail-action-grid">{archived ? <><button className="secondary-button compact" type="button" onClick={() => onArchive(false)}>Restaurar equipo</button>{isProviderAdmin && <button className="danger-button compact" type="button" onClick={onDelete}>Eliminar definitivamente</button>}</> : <><button className="secondary-button compact" type="button" onClick={onRename}>Editar nombre</button>{item.expiry && <button className="secondary-button compact validity-action" type="button" onClick={onModifyValidity}>Modificar período de validez</button>}<button className="secondary-button compact" type="button" onClick={onToggle}>{item.active ? "Desactivar equipo" : "Activar equipo"}</button>{expired && candidate && <button className="primary-button compact" type="button" onClick={onRevalidate}>Revalidar módulo</button>}<button className="secondary-button compact archive-action" type="button" onClick={() => onArchive(true)}>Archivar equipo</button></>}</div>{!archived && expired && !candidate && <div className="form-note warning equipment-detail-hint"><span>!</span>Energiza el MIM para revalidarlo. Las demás opciones siguen disponibles.</div>}</section></div>;
}

function initials(name: string) {
  return name.split(" ").filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function formatCredentialId(value: string) {
  return value.replace(/^nfc-/iu, "RFID-");
}

function formatArchivedDate(value: string) { return formatSiteDate(value, { dateStyle: "medium" }); }
function formatCompactDate(value: string) { return formatSiteDate(value, { dateStyle: "medium" }); }
function formatAssignmentDate(value: string) { return formatSiteDate(value); }

function assignmentExpiresWithin24Hours(item: Equipment, nowMs: number) {
  if (!item.expiry || nowMs <= 0) return false;
  const remaining = new Date(item.expiry).getTime() - nowMs;
  return Number.isFinite(remaining) && remaining > 0 && remaining <= 24 * 60 * 60 * 1000;
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

function localDateTimeFromInstant(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return localDateTimeFromNow(7);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60 * 1000);
  return local.toISOString().slice(0, 16);
}
