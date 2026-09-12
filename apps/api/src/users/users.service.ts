import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@stellar-pay/database';
import type {
  UpdateProfile,
  CreateContact,
  CreateBeneficiary,
  UpdatePreferences,
} from '@stellar-pay/validation';
import { toUserDto } from '../auth/auth.service';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return toUserDto(user);
  }

  async updateProfile(userId: string, input: UpdateProfile) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        displayName: input.displayName,
        avatarUrl: input.avatarUrl,
        locale: input.locale,
        email: input.email,
      },
    });
    return toUserDto(user);
  }

  async preferences(userId: string) {
    const prefs = await this.prisma.userPreference.findUnique({ where: { userId } });
    return {
      currency: prefs?.currency ?? 'USD',
      notificationPreferences:
        (prefs?.notificationPreferences as Record<string, boolean> | null) ?? {},
      theme: prefs?.theme ?? 'dark',
      twoFactorEnabled: prefs?.twoFactorEnabled ?? false,
    };
  }

  async updatePreferences(userId: string, input: UpdatePreferences) {
    const prefs = await this.prisma.userPreference.upsert({
      where: { userId },
      update: {
        currency: input.currency,
        theme: input.theme,
        notificationPreferences: input.notificationPreferences,
      },
      create: { userId, currency: input.currency ?? 'USD', theme: input.theme ?? 'dark' },
    });
    return {
      currency: prefs.currency,
      notificationPreferences:
        (prefs.notificationPreferences as Record<string, boolean> | null) ?? {},
      theme: prefs.theme,
      twoFactorEnabled: prefs.twoFactorEnabled,
    };
  }

  async contacts(userId: string, page: number, pageSize: number) {
    const [items, total] = await Promise.all([
      this.prisma.contact.findMany({
        where: { ownerId: userId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.contact.count({ where: { ownerId: userId } }),
    ]);
    return {
      data: items,
      meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    };
  }

  async createContact(userId: string, input: CreateContact) {
    return this.prisma.contact.create({
      data: {
        ownerId: userId,
        name: input.name,
        publicKey: input.publicKey,
        memo: input.memo,
        memoType: input.memoType,
        isFavorite: input.isFavorite,
        network: input.network,
      },
    });
  }

  async deleteContact(userId: string, contactId: string) {
    await this.prisma.contact.deleteMany({ where: { id: contactId, ownerId: userId } });
    return { ok: true };
  }

  async beneficiaries(userId: string) {
    return this.prisma.beneficiary.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
  }

  async createBeneficiary(userId: string, input: CreateBeneficiary) {
    return this.prisma.beneficiary.create({
      data: {
        userId,
        name: input.name,
        publicKey: input.publicKey,
        currency: input.currency,
        country: input.country,
        bankDetails: input.bankDetails,
      },
    });
  }
}
