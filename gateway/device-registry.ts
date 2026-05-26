import { DurableObject } from 'cloudflare:workers';

export class DeviceRegistry extends DurableObject {
  private devices: string[] = [];

  async register(deviceId: string): Promise<void> {
    if (!this.devices.includes(deviceId)) {
      this.devices.push(deviceId);
    }
  }

  async close(deviceId: string): Promise<void> {
    this.devices = this.devices.filter(d => d !== deviceId);
  }

  listDevices(): string[] {
    return this.devices;
  }
}
