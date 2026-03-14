import { NestFactory } from '@nestjs/core';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import * as compression from 'compression';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT', 3000);
  const nodeEnv = configService.get<string>('NODE_ENV', 'development');

  // Security
  app.use(helmet());
  app.use(compression());

  // CORS
  app.enableCors({
    origin: nodeEnv === 'production'
      ? ['https://app.edupayng.com', 'https://edupayng.com']
      : '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
    credentials: true,
  });

  // API versioning
  app.enableVersioning({ type: VersioningType.URI });
  app.setGlobalPrefix('api');

  // Global pipes – validation
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      stopAtFirstError: false,
    }),
  );

  // Global filters & interceptors
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(
    new LoggingInterceptor(),
    new TransformInterceptor(),
  );

  // Swagger (dev/staging only)
  if (nodeEnv !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('EduPayNG API')
      .setDescription('EduPayNG Educational Platform – REST API')
      .setVersion('1.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'JWT')
      .addTag('Auth', 'Authentication & session management')
      .addTag('Users', 'User profile management')
      .addTag('Wallet', 'Wallet, funding & points')
      .addTag('Tokens', 'Result checker token purchase & management')
      .addTag('Exams', 'CBT exam system')
      .addTag('AI', 'AI course assistant & recommendations')
      .addTag('Payments', 'Payment gateway integration')
      .addTag('Study Materials', 'Learning resources')
      .addTag('Scholarships', 'Scholarship discovery & applications')
      .addTag('Notifications', 'User notification system')
      .addTag('Support', 'Customer support tickets')
      .addTag('Bookmarks', 'Saved items')
      .addTag('Referrals', 'Referral program')
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document, {
      swaggerOptions: { persistAuthorization: true },
    });
  }

  await app.listen(port);
  console.log(`\n🚀 EduPayNG API running on: http://localhost:${port}/api`);
  if (nodeEnv !== 'production') {
    console.log(`📚 Swagger docs: http://localhost:${port}/api/docs`);
  }
}

bootstrap();
