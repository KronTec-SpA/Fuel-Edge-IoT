#!/usr/bin/env swift

import CoreBluetooth
import Darwin
import Foundation

private let magic: [UInt8] = [0x46, 0x45]  // "FE"
private let serviceUUID = CBUUID(string: "e0f10001-7c61-4a9c-9f54-6f2f30c8d001")
private let identityUUID = CBUUID(string: "e0f10002-7c61-4a9c-9f54-6f2f30c8d001")

private func scanDuration() -> TimeInterval {
    guard let index = CommandLine.arguments.firstIndex(of: "--seconds"),
          index + 1 < CommandLine.arguments.count,
          let value = Double(CommandLine.arguments[index + 1]),
          value >= 1, value <= 300
    else { return 45 }
    return value
}

private func argumentValue(_ name: String) -> String? {
    guard let index = CommandLine.arguments.firstIndex(of: name),
          index + 1 < CommandLine.arguments.count
    else { return nil }
    return CommandLine.arguments[index + 1]
}

final class MimScanner: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    private var manager: CBCentralManager!
    private let duration: TimeInterval
    private let inspectIdentity: Bool
    private let expectedModule: String?
    private let expectedFirmware: String?
    private var timerStarted = false
    private var foundIdentifiers = Set<UUID>()
    private var inspectionPeripheral: CBPeripheral?

    init(
        duration: TimeInterval,
        inspectIdentity: Bool,
        expectedModule: String?,
        expectedFirmware: String?
    ) {
        self.duration = duration
        self.inspectIdentity = inspectIdentity
        self.expectedModule = expectedModule
        self.expectedFirmware = expectedFirmware
        super.init()
        manager = CBCentralManager(delegate: self, queue: .main)
    }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        guard central.state == .poweredOn else {
            if central.state == .unsupported || central.state == .unauthorized ||
                central.state == .poweredOff {
                fputs("FALLA bluetooth_no_disponible estado=\(central.state.rawValue)\n", stderr)
                exit(3)
            }
            return
        }
        central.scanForPeripherals(
            withServices: nil,
            options: [CBCentralManagerScanOptionAllowDuplicatesKey: true]
        )
        guard !timerStarted else { return }
        timerStarted = true
        print("ESCANEANDO segundos=\(Int(duration)) magic=FE")
        DispatchQueue.main.asyncAfter(deadline: .now() + duration) { [weak self] in
            guard let self else { exit(4) }
            self.manager.stopScan()
            if self.foundIdentifiers.isEmpty {
                print("RECHAZADO mim_no_detectado")
                exit(2)
            }
            print("APROBADO mim_detectado unidades=\(self.foundIdentifiers.count)")
            exit(0)
        }
    }

    func centralManager(
        _ central: CBCentralManager,
        didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any],
        rssi RSSI: NSNumber
    ) {
        guard let data = advertisementData[CBAdvertisementDataManufacturerDataKey] as? Data else {
            return
        }
        let bytes = [UInt8](data)
        guard bytes.count >= 4, Array(bytes.prefix(2)) == magic else { return }
        guard foundIdentifiers.insert(peripheral.identifier).inserted else { return }
        let advertisedName = advertisementData[CBAdvertisementDataLocalNameKey] as? String
        let name = advertisedName ?? peripheral.name ?? "sin_nombre"
        let flags = String(format: "0x%02x", bytes[3])
        print(
            "MIM name=\(name) protocol=\(bytes[2]) flags=\(flags) " +
                "rssi=\(RSSI.intValue) id=\(peripheral.identifier.uuidString)"
        )
        if inspectIdentity, inspectionPeripheral == nil {
            inspectionPeripheral = peripheral
            central.stopScan()
            central.connect(peripheral)
        }
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        peripheral.delegate = self
        peripheral.discoverServices([serviceUUID])
    }

    func centralManager(
        _ central: CBCentralManager,
        didFailToConnect peripheral: CBPeripheral,
        error: Error?
    ) {
        print("INSPECCION identidad_no_disponible error=\(error?.localizedDescription ?? "desconocido")")
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard error == nil, let services = peripheral.services else { return }
        for service in services where service.uuid == serviceUUID {
            peripheral.discoverCharacteristics([identityUUID], for: service)
        }
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didDiscoverCharacteristicsFor service: CBService,
        error: Error?
    ) {
        guard error == nil, let characteristics = service.characteristics else { return }
        for characteristic in characteristics where characteristic.uuid == identityUUID {
            peripheral.readValue(for: characteristic)
        }
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didUpdateValueFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        guard characteristic.uuid == identityUUID, error == nil,
              let data = characteristic.value,
              let identity = String(data: data, encoding: .utf8)
        else { return }
        print("IDENTIDAD \(identity)")
        manager.cancelPeripheralConnection(peripheral)
        guard let object = try? JSONSerialization.jsonObject(with: data),
              let fields = object as? [String: Any]
        else {
            print("RECHAZADO identidad_json_invalida")
            exit(2)
        }
        let module = fields["module_id"] as? String
        let firmware = fields["firmware"] as? String
        if let expectedModule, module != expectedModule {
            print(
                "RECHAZADO module_id_inesperado esperado=\(expectedModule) " +
                    "recibido=\(module ?? "ausente")"
            )
            exit(2)
        }
        if let expectedFirmware, firmware != expectedFirmware {
            print(
                "RECHAZADO firmware_inesperado esperado=\(expectedFirmware) " +
                    "recibido=\(firmware ?? "ausente")"
            )
            exit(2)
        }
        print("APROBADO mim_detectado identidad_leida=true")
        exit(0)
    }
}

let expectedModule = argumentValue("--expect-module")
let expectedFirmware = argumentValue("--expect-firmware")
let scanner = MimScanner(
    duration: scanDuration(),
    inspectIdentity: CommandLine.arguments.contains("--inspect") ||
        expectedModule != nil || expectedFirmware != nil,
    expectedModule: expectedModule,
    expectedFirmware: expectedFirmware
)
withExtendedLifetime(scanner) {
    RunLoop.main.run()
}
