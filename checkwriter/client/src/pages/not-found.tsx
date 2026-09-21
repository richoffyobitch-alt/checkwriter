import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AlertCircle, ArrowLeft } from "lucide-react";

export default function NotFound() {
  return (
    <div className="grid-surface flex min-h-[60vh] w-full items-center justify-center px-4">
      <Card className="edge-glow w-full max-w-md">
        <CardContent className="pt-6">
          <div className="mb-3 flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-md bg-destructive/15 text-destructive">
              <AlertCircle className="h-5 w-5" />
            </span>
            <h1 className="text-xl font-bold tracking-tight">Page not found</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            That route doesn't exist. It may have been moved, or the link may be out of date.
          </p>
          <Button asChild variant="outline" size="sm" className="mt-5">
            <Link href="/">
              <ArrowLeft className="mr-1.5 h-4 w-4" /> Back to dashboard
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
