import { bearerJsonHeaders, createSingleton, requestJson } from '@nova/shared';

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
      await requestJson('https://api.hubapi.com/crm/v3/objects/contacts', {
        label: 'HubSpot API',
        headers: bearerJsonHeaders(this.hubspotToken),
        body: {
          properties: {
            email: email,
            firstname: firstName,
            lastname: lastName,
            leadsource: 'NOVA Engage Widget',
          },
        },
      });

      console.log(`[CRM Service] Successfully synced lead "${name}" to HubSpot.`);
      return true;
    } catch (err: any) {
      console.error(`[CRM Service] Failed to sync contact with HubSpot CRM:`, err.message);
      return false;
    }
  }
}

export const getCrmService = createSingleton(() => new CrmService());
