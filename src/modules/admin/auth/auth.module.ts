// import { Module } from '@nestjs/common';
// import { JwtModule } from '@nestjs/jwt';
// import { PassportModule } from '@nestjs/passport';
// import { ConfigService } from '@nestjs/config';
// import { APP_GUARD } from '@nestjs/core';


// @Module({
//   imports: [
//     PassportModule,
//     JwtModule.registerAsync({
//       inject: [ConfigService],
//       useFactory: (config: ConfigService) => ({
//         secret: config.getOrThrow('JWT_SECRET'),
//         signOptions: { expiresIn: config.get('JWT_EXPIRES_IN', '1h') },
//       }),
//     }),
//   ],
//   controllers: [AuthController],
//   providers: [
//     AuthService,
//     JwtStrategy,
//     { provide: APP_GUARD, useClass: JwtAuthGuard },
//   ],
//   exports: [AuthService, JwtModule],
// })
// export class AuthModule {}
