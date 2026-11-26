-- Account deletion re-authentication codes
ALTER TYPE "OtpPurpose" ADD VALUE IF NOT EXISTS 'DELETE_ACCOUNT';
