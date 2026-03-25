import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";

// Sub-module controllers + services (inlined)
import {
  AdminDashboardController,
  AdminDashboardService,
} from "./dashboard/dashboard.module";
import { AdminUsersController, AdminUsersService } from "./users/users.module";
import {
  AdminTransactionsController,
  AdminTransactionsService,
} from "./transactions/transactions.module";
import {
  AdminSupportController,
  AdminSupportService,
} from "./support/support.module";
import {
  AdminContentController,
  AdminContentService,
} from "./content/content.module";
import {
  AdminSystemController,
  AdminSystemService,
} from "./system/system.module";

// Existing admin controllers
import { AdminController } from "./admin.controller";
import { VendorFundingController } from "./vendor-funding.controller";
import { VendorFundingService } from "../../common/services/vendor-funding.service";

// Chargeback
import { ChargebackModule } from "./chargebacks/chargeback.module";

// Shared services
import { SettlementService } from "../../common/services/settlement.service";
import { RevenueService } from "../../common/services/revenue.service";
import { PricingService } from "../../common/services/pricing.service";
import { WalletModule } from "../wallet/wallet.module";

// Role guard
import { AdminRolesGuard } from "./admin.guard";

@Module({
  imports: [WalletModule, ChargebackModule],
  controllers: [
    AdminController,
    VendorFundingController,
    AdminDashboardController,
    AdminUsersController,
    AdminTransactionsController,
    AdminSupportController,
    AdminContentController,
    AdminSystemController,
  ],
  providers: [
    AdminDashboardService,
    AdminUsersService,
    AdminTransactionsService,
    AdminSupportService,
    AdminContentService,
    AdminSystemService,
    VendorFundingService,
    SettlementService,
    RevenueService,
    PricingService,
    // Apply role guard globally within admin routes
    { provide: APP_GUARD, useClass: AdminRolesGuard },
  ],
})
export class AdminModule {}
