import boto3

AWS_ACCESS_KEY_ID = ""
AWS_SECRET_ACCESS_KEY = ""
AWS_REGION = ""
AWS_BUCKET = ""

file_key = ""

s3 = boto3.client(
    "s3",
    aws_access_key_id=AWS_ACCESS_KEY_ID,
    aws_secret_access_key=AWS_SECRET_ACCESS_KEY,
    region_name=AWS_REGION,
)

try:
    response = s3.get_object(
        Bucket=AWS_BUCKET,
        Key=file_key,
    )
    presigned_url = s3.generate_presigned_url(
    "get_object",
    Params={
        "Bucket": AWS_BUCKET,
        "Key": file_key,
    },
    ExpiresIn=300,
)

    print("PRESIGNED URL OK")
    print(presigned_url)
    

    print("S3 TEST OK")
    print("Bucket:", AWS_BUCKET)
    print("Key:", file_key)
    print("Content-Type:", response.get("ContentType"))
    print("Size:", response.get("ContentLength"))

except Exception as e:
    print("S3 TEST FAILED")
    print(repr(e))