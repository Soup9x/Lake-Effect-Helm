/**
 * Which box a configuration is drawn as on a network diagram.
 *
 * topology_device_type is an icon, not a classification (0570), so this maps
 * the configuration's real device_type onto the six shapes the canvas draws.
 * A storage array and a hypervisor are both drawn as a server; a printer is a
 * plain box.
 */
export const TOPOLOGY_SHAPES = ['switch', 'router', 'firewall', 'server', 'access_point', 'generic'] as const;
export type TopologyShape = (typeof TOPOLOGY_SHAPES)[number];

const BY_DEVICE: Record<string, TopologyShape> = {
  switch: 'switch',
  router: 'router',
  firewall: 'firewall',
  access_point: 'access_point',
  server: 'server',
  virtual_machine: 'server',
  hypervisor: 'server',
  nas: 'server',
  san: 'server',
};

export function shapeForDevice(deviceType: string | null | undefined): TopologyShape {
  return (deviceType && BY_DEVICE[deviceType]) || 'generic';
}
