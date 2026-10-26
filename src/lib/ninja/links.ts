/**
 * Links into NinjaOne's own pages (1090). They go to the address people sign
 * in at — the MSP's custom domain if one is set — and fall back to the API's
 * regional host, which is the same instance under its stock name.
 */
export function ninjaPortal(connection: { baseUrl: string; portalUrl: string | null }): string {
  return connection.portalUrl ?? connection.baseUrl;
}

export function ninjaDeviceUrl(portal: string, deviceId: string): string | null {
  return /^\d+$/.test(deviceId) ? `${portal}/#/deviceDashboard/${deviceId}/overview` : null;
}

export function ninjaOrganizationUrl(portal: string, ninjaOrgId: string): string | null {
  return /^\d+$/.test(ninjaOrgId) ? `${portal}/#/customerDashboard/${ninjaOrgId}/overview` : null;
}
