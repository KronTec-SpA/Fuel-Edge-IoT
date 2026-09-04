#include <Arduino.h>

void setup() {
  Serial.begin(115200);
  delay(300);

  Serial.printf("# chip=%s, cores=%u, cpu_mhz=%u\n",
                ESP.getChipModel(),
                ESP.getChipCores(),
                ESP.getCpuFreqMHz());
  Serial.println("uptime_ms,free_heap_bytes,chip_temp_c");
}

void loop() {
  Serial.printf("%lu,%u,%.1f\n",
                millis(),
                ESP.getFreeHeap(),
                temperatureRead());
  delay(1000);
}
