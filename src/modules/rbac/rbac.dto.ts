import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export class CreateRoleDto {
  @Matches(/^[A-Z][A-Z0-9_]{2,40}$/, { message: 'key must be UPPER_SNAKE_CASE' })
  key: string;
  @IsString() @MaxLength(80) name: string;
  @IsOptional() @IsString() @MaxLength(300) description?: string;
  @IsArray() @ArrayUnique() @ArrayMaxSize(100) @IsString({ each: true }) permissions: string[];
}

export class UpdateRoleDto {
  @IsOptional() @IsString() @MaxLength(80) name?: string;
  @IsOptional() @IsString() @MaxLength(300) description?: string;
  @IsOptional() @IsArray() @ArrayUnique() @ArrayMaxSize(100) @IsString({ each: true }) permissions?: string[];
}

export class SetUserRolesDto {
  @IsArray() @ArrayUnique() @ArrayMaxSize(20) @IsString({ each: true }) roles: string[];
}

export class RoleResponse {
  @ApiProperty() id: string;
  @ApiProperty() key: string;
  @ApiProperty() name: string;
  @ApiPropertyOptional({ nullable: true }) description: string | null;
  @ApiProperty() isSystem: boolean;
  @ApiProperty() userCount: number;
  @ApiProperty({ type: [String] }) permissions: string[];
}

export class UserAccessResponse {
  @ApiProperty({ type: [String] }) roles: string[];
  @ApiProperty({ type: [String] }) permissions: string[];
}
