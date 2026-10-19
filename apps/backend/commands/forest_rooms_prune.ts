import { BaseCommand } from "@adonisjs/core/ace";
import type { CommandOptions } from "@adonisjs/core/types/ace";

export default class ForestRoomsPrune extends BaseCommand {
    static commandName = "forest:rooms:prune";
    static description = "Prune expired Forest command receipts (24h) and release audits (90 days)";
    static options: CommandOptions = { startApp: true };
    async run() {
        const { forestRoomsService } = await import("#services/forest_rooms_service");
        const result = await forestRoomsService.prune();
        this.logger.info(
            `Pruned ${result.receipts} expired receipts and ${result.releases} expired release audits`,
        );
    }
}
