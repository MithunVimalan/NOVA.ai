export class CrmService {
  private hubspotToken: string = process.env.HUBSPOT_ACCESS_TOKEN || '';

  /**
   * Syncs a captured visitor lead to HubSpot CRM
   */
  async syncLeadToHubSpot(name: string, email: string): Promise<boolean> {
    if (!this.hubspotToken) {
      console.info('[CRM Service] HubSpot sync skipped. HUBSPOT_ACCESS_TOKEN environment variable not set.');
      return false;
    }

    console.log(`[CRM Service] Syncing lead to HubSpot: ${name} (${email})`);

    // Parse first and last name
    const nameParts = name.trim().split(/\s+/);
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';

    try {
      const response = await fetch('https://api.hubapi.com/crm/v3/objects/contacts', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.hubspotToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          properties: {
            email: email,
            firstname: firstName,
            lastname: lastName,
            leadsource: 'NOVA Engage Widget',
          },
        }),
      });

      if (response.ok) {
        console.log(`[CRM Service] Successfully synced lead "${name}" to HubSpot.`);
        return true;
      } else {
        const errorText = await response.text();
        console.error(`[CRM Service] HubSpot API returned status ${response.status}: ${errorText}`);
        return false;
      }
    } catch (err: any) {
      console.error(`[CRM Service] Failed to sync contact with HubSpot CRM:`, err.message);
      return false;
    }
  }
}

let crmServiceInstance: CrmService | null = null;
export function getCrmService(): CrmService {
  if (!crmServiceInstance) {
    crmServiceInstance = new CrmService();
  }
  return crmServiceInstance;
}
