export class GreatBookFieldClient {
  async loadFromUrl(url: string): Promise<unknown> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to load projection: ${response.status}`);
    }
    return response.json();
  }
}
