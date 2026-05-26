export class DeviceRegistry {
  private devices = new Set<string>();

  register(deviceId: string): void {
    this.devices.add(deviceId);
  }

  close(deviceId: string): void {
    this.devices.delete(deviceId);
  }

  listDevices(): string[] {
    return [...this.devices];
  }
}
